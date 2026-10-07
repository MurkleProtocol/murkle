# Murkle: specification v1 (signet)

Private tokens on Bitcoin L1: a metaprotocol that requires no soft fork. Bitcoin only stores
and orders the data. The pool state (note tree, nullifier set, per-block roots) is computed
deterministically by replaying blocks in order, as with Runes and Alkanes: anyone can re-run the
rules and must get the same result. Bitcoin itself does not verify the proofs; every replayer does.

The design is close to the "Shielded Bitcoin" design by [[alloc] init] (2026-09-24), but without a BTC bridge:
tokens are created inside the protocol.

Status: **signet only**, test coins with no value. Phase 1 of the Groth16 setup is the public
Perpetual Powers of Tau transcript; phase 2 is a **DEV single-party contribution** (audit A-8):
whoever made it could forge proofs until a public ceremony replaces it.

Mainnet is **not launched**: no mainnet genesis is pinned (`src/pins.mainnet.json`), and the mainnet
phase-2 key comes from a public ceremony that has not run yet (docs/CEREMONY.md, docs/MAINNET.md).

All names and pinned constants live in `src/params.mjs` and the network's pins file (`src/pins.json` for
signet, `src/pins.mainnet.json` for mainnet). The table below is signet; section 1.1 lists what differs on mainnet.

| Constant | Value |
|---|---|
| Protocol / brand | `murkle` / Murkle |
| Magic | `mrk` (3 ASCII bytes) |
| Envelope version | `0x00` |
| Address HRP | `mrk` (addresses look like `mrk1…`) |
| Domain tags | `murkle/<name>`: `spend`, `view`, `note`, `btc-fee`, `btc-mine-fee`, `relay/pow/v1`, `mine/v1`, `digest/v1`, `digest/v2` |
| Digest version | `DIGEST_V = 2`: v1 below the mining activation height, v2 from it (section 10) |
| Snapshot version | 3 (the v2 layout is still written while no activation is at or below the height, section 12) |
| Activations | `src/pins.json` `activations`: `mining` at height `325138` (signet, pinned 2026-10-06): ops 7 – 9 are unknown below it and follow §15 from it |

## 1. Settled decisions
| Topic | Decision | Rationale |
|---|---|---|
| State | Deterministic replay by every indexer, as in Runes and Alkanes | No dedicated network or consensus |
| Assets | Multiple tokens in a **single** pool. `asset` is part of the note commitment and is hidden in private transfers | Shared anonymity set for all tokens |
| Proofs | Groth16 / BN254, Circom 2.2.2 + circomlib Poseidon | 128-byte proof, in-browser proving (snarkjs) |
| Transfer | Strictly 2 inputs → 2 outputs, missing notes are empty | One circuit, one setup, arity does not leak |
| Tree | Poseidon(2), depth 32 (up to ~4.3 billion notes), empty leaf = 0 | — |
| Note encryption | x25519 + HKDF-SHA256 + ChaCha20-Poly1305, a fresh ephemeral key per output | Encryption is **not proven** in the circuit (audit A-7): the circuit is ~10 times simpler than in the paper |
| Carrier | A single `OP_RETURN` (Bitcoin Core v30 policy) | One transaction, simple indexer |
| Anchor | Block height: `H−100 ≤ h_anchor ≤ H−1` (W=100, Kmin=1) | As in the paper: ~16 h to publish |
| Binding | `extDataHash` = SHA-256 of the entire envelope body (excluding the proof) >> 8 | The envelope is immutable |
| Indexer | JavaScript (Node and browsers). Verification via snarkjs, Poseidon via poseidon-lite | Same code in the server, the CLI and the browser |
| Name | Murkle, magic `mrk` | A 3-byte magic keeps envelope sizes fixed |

### 1.1 Networks

One switch selects the network: `MURKLE_NETWORK=signet|mainnet` in Node (read once, when
`src/params.mjs` is imported), or the value the web build baked in (Vite define `__MURKLE_NETWORK__`).
Unset or empty means `signet`, the default, whose values are exactly those of the table above. Any other
value refuses to load. The chains are separate, so the envelope magic, version, sizes and every wire format
are the same on both networks.

| | signet | mainnet |
|---|---|---|
| Bitcoin addresses | `tb1…` | `bc1…` |
| Shielded addresses (HRP) | `mrk1…` | `murk1…` |
| Wallet key labels (spend, view, btc-fee, btc-mine-fee) | `murkle/<name>` | `murkle/mainnet/<name>` |
| Pins | `src/pins.json` | `src/pins.mainnet.json` (genesis `null` until the mainnet ATTEST) |
| Artifacts | `build/dev/*`, `build/manifest.json` (DEV phase 2) | `build/mainnet/*` (public ceremony); the wasm is shared |
| Ticker rule (section 7) | historical decoder | strict raw bytes (V2-02), from genesis |
| Service fee of mining (section 15) | 500 sats to the signet platform script | placeholder `TODO_PLATFORM_ADDRESS`: mining refuses to start |
| Explorer / Esplora default | mempool.space/signet | mempool.space |
| Browser storage prefix | `murkle.signet` | `murkle.mainnet` |

Protocol hashes never depend on the network: `murkle/note`, `murkle/relay/pow/v1`, `murkle/mine/v1` and the
digest tags are the same strings on both.

## 2. Keys and address
- `seed`: 32 random bytes.
- `sk = HKDF-SHA256(seed, info="murkle/spend", 64 bytes) mod r`, `pk = Poseidon(sk)`: spending authority.
- `vsk = HKDF-SHA256(seed, info="murkle/view", 32 bytes)`: x25519 secret for decrypting
  incoming notes, `vpk = X25519(vsk)`.
- Address = bech32m(`"mrk"`, `pk(32) ‖ vpk(32)`).
- **Mainnet** (section 1.1): the HRP is `"murk"` (addresses `murk1…`), and the wallet key labels carry the
  network: `sk` from `info="murkle/mainnet/spend"`, `vsk` from `"murkle/mainnet/view"`, and the two Bitcoin
  fee keys from `"murkle/mainnet/btc-fee"` and `"murkle/mainnet/btc-mine-fee"`. So one recovery phrase used on
  both networks never gives the same keys there; in particular the same Bitcoin fee key on signet and mainnet
  would link the two networks' activity publicly. Signet keeps `murkle/<name>`.
- A wallet refuses a shielded address of the other network with a clear message ("This is a Murkle signet
  address (mrk1…). This wallet is on Bitcoin mainnet." and the mirror on signet) instead of paying it.
- `vsk` grants read-only access: incoming notes are visible, but they cannot be spent (that requires `sk`),
  and spent notes cannot be distinguished from unspent ones (the nullifier requires `sk`).

## 3. Note
- `commitment = Poseidon(asset, amount, pk, blinding)`;
  `amount < 2^64`, `blinding`: 248 random bits;
  `asset`: u64 `(DEPLOY height << 32) | transaction index in block`.
- `nullifier = Poseidon(commitment, leafIndex, Poseidon(sk, commitment, leafIndex))`.
  The nullifier is bound to the note's position in the tree, so identical notes at different positions
  are spent independently.
- Output ciphertext (95 bytes) = `epk(32) ‖ ChaCha20-Poly1305(key, nonce=0, aad=commitment, pt)`:
  - `pt = asset u64 LE ‖ amount u64 LE ‖ blinding (31 bytes BE)`: 47 bytes plus a 16-byte tag;
  - `key = HKDF-SHA256(X25519(esk, vpk), salt=epk‖vpk, info="murkle/note")`.
- The recipient tries to decrypt every output with its `vsk` and accepts a note only if
  `Poseidon(asset, amount, own pk, blinding)` matches the published `commitment`.

## 4. Circuit (`circuits/transaction.circom`) and setup
- **Public inputs**, in fixed order: `root, publicAmount, publicAsset, extDataHash,
  nullifier[2], commitment[2]`.
- **Constraints:**
  - an input note with a nonzero amount is in the tree under `root`;
  - the spender knows `sk` (via the commitment and the nullifier);
  - nullifiers are computed correctly and are pairwise distinct;
  - output commitments are correct;
  - all amounts are less than 2^64;
  - `Σin + publicAmount = Σout`;
  - `publicAmount · (asset − publicAsset) = 0`.
- **Size:** 18,411 non-linear constraints (circom 2.2.2 `--O2`); a 2^15 ptau is sufficient.
- **Setup** (`npm run circuit:build`):
  - Phase 1: `powersOfTau28_hez_final_15.ptau` from the public Perpetual Powers of Tau. The build
    checks its sha256 and the blake2b-512 published by snarkjs, and runs `snarkjs powersoftau verify` once.
  - Phase 2: a DEV single-party contribution, then `snarkjs zkey verify` against the r1cs and the ptau.
  - The build writes `build/manifest.json`
    (`{ protocol, envelopeVersion, circom, circomlib, constraints, sha256: { r1cs, wasm, zkey, vkey, ptau }, setup, gitCommit }`)
    and pins `manifestSha256` and the wasm, zkey and vkey sha256 in `src/pins.json`.
  - The r1cs and wasm are reproducible from source with circom 2.2.2. The zkey is not (it contains a
    random contribution): it is a published artifact pinned by hash.

## 5. `TRANSACT` envelope (op = 0x01), 471 bytes
| Field | Bytes |
|---|---|
| magic `mrk` ‖ version `0x00` ‖ op `0x01` | 5 |
| `h_anchor` u32 LE | 4 |
| `publicAsset` u64 LE (0 for a private transfer) | 8 |
| `publicAmount` i64 LE | 8 |
| `nullifier[2]` (32 bytes BE) | 64 |
| `commitment[2]` | 64 |
| `noteCiphertext[2]` | 190 |
| proof (compressed: A 32 ‖ B 64 ‖ C 32) | 128 |

The complete Bitcoin transaction comes to ≈ **600 vB** (1 P2TR input, change, OP_RETURN).
For comparison, the paper's transaction is ~740 vB.

## 6. Indexer rules (order matters; state changes only at the end)
0. Replay starts at the activation height. When genesis is pinned, the genesis rule (section 9)
   applies to that block before anything else.
1. Find the envelope, then parse it strictly canonically; a parse failure, or a DEPLOY that breaks
   a rule of its table (section 7), is logged as rejected (`malformed: …`) and changes no state.
   The envelope is found exactly like this, output by output in order:
   - The output's scriptPubKey must start with `OP_RETURN` (0x6a).
   - Its payload is the concatenation, in order, of the data of every push after the 0x6a: a direct
     push (opcodes 0x01-0x4b) or `OP_PUSHDATA1/2/4` (0x4c/0x4d/0x4e, little-endian length). Non-minimal
     pushes are allowed, and an envelope may be split over several pushes.
   - Any other opcode after the 0x6a, including `OP_0` (0x00), `OP_1NEGATE` (0x4f), `OP_RESERVED`
     (0x50) and `OP_1`..`OP_16` (0x51-0x60), or a push whose length runs past the end of the script,
     means that output carries no envelope (even though Bitcoin's `IsPushOnly` counts the small-number
     opcodes as pushes). The search moves on to the next output.
   - The first output whose payload starts with the 3 bytes `mrk` carries the envelope; later outputs
     are ignored, and a transaction with no such output has no envelope (no log entry).

   "Strictly canonical" applies to the envelope bytes (exact length, known version and op, no
   trailing bytes), not to how they are pushed.
   **Activation gate (section 15).** Before strict parsing: a payload whose version byte is `0x00` and
   whose op is 7, 8 or 9 (MINE, MINE_SCRIPT, DEPLOY_POW) is logged as `malformed: unknown op N` with
   `opName` UNKNOWN when the block is below the mining activation height (or none is scheduled),
   whatever its body. Exactly as before mining existed: no state other than `stats.rejected` changes,
   and `logAcc` folds the same bytes.
2. ATTEST (section 8) is logged as accepted and changes no state. Rules 3 to 7 concern
   TRANSACT, MINT, MINT_SCRIPT and DEPLOY; DEPLOY_POW, MINE and MINE_SCRIPT follow section 15.
3. Check the anchor window: `root = R[h_anchor]`.
4. No nullifier may appear in `N` or repeat within the envelope.
5. `publicAmount` / `publicAsset` rules for the operation (section 7);
   if `publicAmount = 0`, then `publicAsset = 0` is required.
6. `extDataHash` is recomputed from the bytes.
   The proof is decompressed with strict point validation:
   - coordinates are canonical;
   - points lie on the curve;
   - point B lies in the G2 subgroup;
   - the point at infinity is rejected.

   snarkjs itself checks only curve membership. This is followed by Groth16 verification
   against the public inputs and the pinned verification key.
7. Application: commitments are appended to the tree in output order,
   nullifiers are added to `N`, and the asset issuance accounting is updated.
8. After each block, `R[H]` and `digest(H)` (section 10) are stored for every height and never pruned;
   for a block with no operations, `R[H] = R[H−1]`.
9. Reorgs: a per-block rollback journal covers the last 144 blocks. It restores the tree, the
   nullifiers, the asset table, the log (and its `seq`), the digest accumulators and the statistics.
10. A block is applied all or nothing. If a lookup fails mid-block (a MINT_SCRIPT prevout the data
    source cannot serve), the same journal undoes that block's partial changes and replay retries
    the whole block later. A failed lookup is never turned into a verdict.

Pool accounting: for each asset the indexer tracks `pool[asset] = deposited − withdrawn`. In v1 nothing
is ever withdrawn (rule 5 and section 7 reject every TRANSACT with a nonzero `publicAmount`), so `pool[asset]` only
grows with mints and no rule compares anything against it yet. When withdrawals (negative
`publicAmount`, section 7) are enabled, the same change must add the rule: a withdrawal larger than
`pool[asset]` is rejected. Until then this bound does not exist.

What the cap does and does not guarantee: the mint rules of section 7 (`minted < mintCap`,
`publicAmount = mintAmount`) bound the public issuance to `mintAmount × mintCap` whatever the circuit
does. They do not bound the value held in private notes. Only the circuit constraint
`Σin + publicAmount = Σout` ties note values to public amounts, so a circuit soundness bug or a forged
proof (the phase 2 setup is a single-party dev contribution, audit A-8) could create notes worth more
than was minted, through MINT or TRANSACT. v1 has no unshield, so the indexer cannot detect such
inflation. Once withdrawals exist, the `pool[asset]` bound will only cap what leaves the pool, not what
circulates inside it.

## 7. Product layer
- **Anyone can issue a token** with a DEPLOY operation.
- **Open mint for sats.** No premine.
- **Private pool only in v1.** TRANSACT must have `publicAmount = publicAsset = 0`.
  Withdrawal from the pool (negative `publicAmount`) is already supported by the circuit; it will be enabled
  together with the transparent part.

### DEPLOY (op = 0x02), no proof
| Field | Type |
|---|---|
| ticker | u8 length + ASCII `[A-Z0-9]{1,16}`, unique: the first valid DEPLOY claims the ticker |
| divisibility | u8, ≤ 8 |
| mintAmount | u64 LE, > 0 and ≤ 2^63 − 1 (MINT carries `publicAmount` as i64): units per mint |
| mintCap | u32 LE, > 0: number of mints; `mintAmount × mintCap` ≤ u64 |
| priceSats | u64 LE: mint price, 0 = free |
| treasury | u8 length + scriptPubKey (≤ 64), required when priceSats > 0 |
| startHeight / endHeight | u32 LE / u32 LE, 0 = unbounded; when endHeight ≠ 0, endHeight ≥ startHeight |

A DEPLOY that breaks any rule of this table (or carries trailing bytes) is malformed (section 6,
rule 1): it is logged as `malformed: …` with ok = false, claims no ticker and adds no asset. A later
valid DEPLOY can still claim that ticker.

**Ticker bytes, per network (audit V2-02).** The same rule applies to the DEPLOY_POW ticker (section 15).
- **Mainnet, from genesis (strict):** once the envelope has parsed whole (lengths, no trailing bytes), the raw
  ticker bytes must be 1 to 16 bytes, each `0x30..0x39` or `0x41..0x5A`. Anything else is malformed with
  `malformed: ticker bytes must be 1-16 of A-Z0-9`.
- **Signet, forever (historical):** the bytes are decoded as UTF-8 (TextDecoder: a leading byte-order mark
  `EF BB BF` is stripped and invalid bytes become U+FFFD), then the text must match `[A-Z0-9]{1,16}`.
- The two rules accept different byte strings only when the ticker starts with `EF BB BF` followed by 1 to
  16 valid characters (signet accepts it, mainnet does not). No signet DEPLOY depends on that (checked by a
  replay of the live chain), so signet keeps its verdicts with no activation height.

- `asset id = (height << 32) | transaction index in block`; the coinbase has index 0.
- The block adapter must pass **all** transactions of the block in their original order.

### MINT (op = 0x03), body as in TRANSACT plus `bindOutpoint`
- `bindOutpoint` immediately follows `publicAmount` (36 bytes: txid in internal byte order ‖ vout u32 LE).
  This is the UTXO that the carrier transaction spends as its **first input**. The MINT envelope is 507 bytes.
- The field is covered by `extDataHash`, so an envelope copied from the mempool is invalid in any
  other transaction (audit A-6). An RBF replacement of the same transaction keeps the input, so the envelope remains valid.

### MINT_SCRIPT (op = 0x04): the same mint, bound to an address instead of a UTXO
- `bindOutpoint` is replaced by `bindScriptHash` (32 bytes) = sha256(payer's scriptPubKey).
  The envelope is 503 bytes.
- The indexer requires the transaction's first input to spend an output with that scriptPubKey.
  It reads the spent output from the **raw** previous transaction (`/tx/{txid}/hex` on an Esplora API,
  cached), recomputes its txid from the bytes and refuses a mismatch, so a data source cannot
  substitute another script. A self-hosted node requires `txindex`.
- **Order.** The prevout lookup is the last check, after the Groth16 verification, so an envelope
  without a valid proof never costs a network lookup. Every rule must pass either way, so the order
  changes only which reason a doubly invalid envelope is logged with, never a verdict or a digest
  (the log reason is not in the digest). Before the mining release the lookup ran first.
- **Coinbase.** A coinbase spends no output, so it has no payer. A MINT_SCRIPT whose first input is the
  null outpoint (zero txid, vout `0xffffffff`; only a coinbase has one) is rejected with
  `MINT not bound to this payer`, without any prevout lookup. Before this rule every replayer stalled
  at such a block looking up the null outpoint (audit A-12). No such transaction exists on signet
  since activation height 324,592, so no past verdict changes. A plain MINT needs no lookup:
  in a coinbase it binds only if its `bindOutpoint` is the null outpoint itself.
- Needed for wallets that select coins themselves (Unisat `sendBitcoin`): the inputs are not known in advance,
  but the address is. A copied envelope is equally useless: an attacker cannot spend
  coins from someone else's address.

For MINT and MINT_SCRIPT the indexer additionally requires:
- the transaction's first input = `bindOutpoint` (MINT) or spends an output with `bindScriptHash` (MINT_SCRIPT);
- `publicAsset` is an existing asset;
- `publicAmount = mintAmount`;
- the height is within the window `[startHeight, endHeight]`;
- `minted < mintCap`;
- the sum of the same Bitcoin transaction's outputs paying to `treasury` ≥ `priceSats`.

Mints are processed in block transaction order. A mint that arrives after the cap has been reached
is rejected, and the sats paid are not refunded, as with Runes (they are counted as `burnedSats`).
There is no per-wallet limit in the MVP: it can be bypassed with multiple wallets.

## 8. ATTEST (op = 0x05), 38 bytes, no proof
| Field | Bytes |
|---|---|
| magic `mrk` ‖ version `0x00` ‖ op `0x05` | 5 |
| kind u8: 1 = genesis, 2 = checkpoint (reserved), 3 = release (reserved) | 1 |
| hash | 32 |

- Decoding is strict: exactly 38 bytes and a known kind; anything else is malformed.
- The indexer logs `{ op: 5, kind, hash, ok: true }` and **never** changes pool state for it.
  Anyone can post an ATTEST. Authority comes only from the genesis txid pinned in the open-source code.
- At 38 bytes it fits any `OP_RETURN` relay policy, so any wallet can post it.

## 9. Genesis rule and pins
- Each network has its own pins file: `src/pins.json` (signet, unchanged) and `src/pins.mainnet.json`
  (mainnet). The mainnet file starts with `manifestSha256`, `artifacts.zkey`, `artifacts.vkey`,
  `genesisTxid` and `activationHeight` all `null` and the mining activation `null`; its wasm pin equals
  signet's (same circuit). The ceremony's `finalize --install` writes the artifact pins (only while
  `genesisTxid` is null); the operator writes the genesis fields after the mainnet ATTEST confirms
  (docs/MAINNET.md). On mainnet the server refuses to start with an unpinned verification key, and before
  genesis unless `MURKLE_ALLOW_PRE_GENESIS=1` (staging only).
- `src/pins.json` holds `{ manifestSha256, artifacts: { wasm, zkey, vkey }, genesisTxid, activationHeight, activations }`.
- `activations` lists every consensus change after v1 as `{ name, height, digestV }`: names unique,
  `digestV` 2, 3, … in table order, heights `null` (not scheduled) or above the genesis height and
  non-decreasing among the scheduled ones. This release lists `{ "name": "mining", "height": null,
  "digestV": 2 }`. A height is set only in a release, at a future height, so no past verdict changes.
  The build writes the first two; the operator writes the genesis fields after posting
  `murkle attest genesis <wallet>` (ATTEST kind 1 over `manifestSha256`) and seeing it confirm.
- With genesis pinned, replay starts at `activationHeight`, and that block must contain the transaction
  `genesisTxid` carrying ATTEST kind 1 with `hash = manifestSha256`. Otherwise replay halts with
  `genesis mismatch`. This runs in every replay: server, CLI and browser.
- **Signet genesis (live).** The genesis ATTEST is transaction
  `4c32443828131fe142d899007c1b8885aef7e62da3034c6f03e4ff7096c6dfad`, mined at activation height
  324,592, both pinned in `src/pins.json`.
- Node entry points refuse a `verification_key.json` whose sha256 differs from the pinned one.
- **Pre-genesis mode** (genesis fields `null`): indexers start from saved state or at tip + 1, skip the
  genesis check, and every surface shows a pre-genesis warning.
- State from another protocol version, start height or genesis is archived to `data/<network>/archive/`,
  never deleted, and replay restarts.

## 10. State digest (v1, and v2 from the mining activation)
Rolling accumulators in apply order, both starting at 32 zero bytes:
- `logAcc = sha256(logAcc ‖ txid ‖ ok u8 ‖ op u8)` for every envelope found, rejected ones included;
  reason strings are excluded. `txid` is the 32 bytes of its usual (display) hex; `op` is the header op
  byte, or 0 when the payload is too short to have one.
- `nullAcc = sha256(nullAcc ‖ nullifier 32 BE)` for every applied nullifier.

Per block, after all its transactions:
- `assetsHash = sha256(concat over assets sorted by id of: id u64 LE ‖ minted u32 LE ‖ pool u64 LE ‖ sha256(deploy envelope))`
  (sha256 of the empty string when there are no assets).
- `digest(h) = sha256("murkle/digest/v1" ‖ h u32 LE ‖ blockHash 32 ‖ root 32 BE ‖ nullAcc ‖ logAcc ‖ assetsHash)`,
  where `blockHash` is the 32 bytes of the display hex (zeros if a synthetic block has none).

**Digest version.** `digestVersion(h)` is the `digestV` of the newest activation whose height is
`≤ h`, or 1. Each later version contains every field of the earlier ones. The switch happens at the
activation height whether or not any mining operation ever lands; `/api/digest` adds
`version` only when it is 2 or more.
- v1 (above): unchanged, byte for byte, below the mining activation height.
- v2: `digest(h) = sha256("murkle/digest/v2" ‖ h u32 LE ‖ blockHash 32 ‖ root 32 BE ‖ nullAcc ‖ logAcc ‖
  assetsHash ‖ minedHash ‖ mineAcc)`, where `assetsHash` is the v1 formula over paid-mint (DEPLOY)
  assets only, `minedHash = sha256(concat over mined assets sorted by id of: id u64 LE ‖ claims u64 LE ‖
  issued u64 LE ‖ dHeight u32 LE ‖ dValue u64 LE ‖ sha256(deploy envelope))` (sha256 of the empty
  string when none), `[dHeight, dValue]` is the asset's newest difficulty point (section 15), and
  `mineAcc` starts at 32 zero bytes and becomes `sha256(mineAcc ‖ solutionId)` per accepted claim.

Digests are stored per height and never pruned. Two replayers that agree on `digest(h)` agree on the
chain up to `h`, the tree root, every applied nullifier, every envelope verdict and the asset table.
`murkle audit [--esplora url] [--compare url] [--from h] [--to h]` replays from the activation height (or
`--from`) into memory. With `--compare` it reports one of:
- `OK up to H (N heights compared)`, exit code 0;
- the first diverging height and component, exit code 2;
- `nothing compared`, exit code 1, when no height from `--from` on is on both sides (the local replay
  applied no block, or the remote is behind `--from`). An empty comparison is never reported as OK.

When the first differing height is where the digest version changes, the other side runs a
different release, not a different chain.

## 11. Log entries and statistics
- Log entry: `{ seq, height, index, txid, op, opName, ok, reason?, asset?, ticker?, amount?, kind?, hash? }`.
  - `seq` is the entry's position in the full log; `index` is the transaction's index in its block.
  - `opName` is DEPLOY, MINT, MINT_SCRIPT, TRANSFER (for TRANSACT), ATTEST, DEPLOY_POW, MINE or
    MINE_SCRIPT (UNKNOWN for an unrecognised op byte in a malformed envelope, and for ops 7, 8 and 9
    below the mining activation height).
  - DEPLOY_POW carries `ticker` and, when accepted, `asset`. MINE and MINE_SCRIPT carry `asset`,
    `ticker` (when the asset exists), `amount` and `ref` (the reference height); an accepted claim also
    carries `difficulty` (its `D_eff`). A claim never names a recipient.
  - DEPLOY carries `ticker` and, when accepted, `asset`. MINT and MINT_SCRIPT carry `asset`,
    `ticker` (when the asset exists) and `amount`. ATTEST carries `kind` and `hash`.
    TRANSACT entries never carry `asset` or `amount`: they are private.
  - Bigints are decimal strings.
- Global statistics: `{ accepted: { deploy, mint, transact, attest }, rejected, outputsByHeight: [[h, n]], transfersByHeight: [[h, n]] }`;
  `accepted.mine` appears with the first accepted claim (DEPLOY_POW counts as `deploy`).
- Per asset: `deployTxid`, `deployHeight`, `firstMintHeight`, `soldOutHeight`, `treasurySats`,
  `rejectedMints`, `burnedSats`, `mintsByHeight: [[h, n]]`.
  - `treasurySats` is the gross sum of every output paying to the treasury script in the
    transactions of accepted mints; `burnedSats` is the same sum over rejected mints of a known asset.
    Both are what the price rule counts (section 7), so they include overpayment and any change a payer
    sends back to the treasury script: when the treasury itself funds a mint (the deployer minting from
    the treasury address, which the launch form prefills), its change is counted too. They measure sats
    sent to the treasury address, not revenue: the indexer never resolves where inputs came from, so it
    cannot net that change out, and an issuer can raise the figure at no cost. `priceSats × minted` is
    the nominal mint revenue. Neither field is part of `assetsHash` or the digest.

## 12. Snapshot (v2, v3)
`Indexer.snapshot()` is JSON: `{ version: 2, protocol, envelopeVersion, digestVersion, genesis, startHeight,
height, outputs, nullifiers, roots, hashes, digests, acc: { logAcc, nullAcc }, assets (with statistics),
stats, undo, log }`. `restore()` refuses any other version or protocol (the caller resyncs), and checks that
the rebuilt tree root and the recomputed digest match the stored ones.

Version 3 adds `activations` (the table in effect), `digestVersion: 2`, `mine: { mineAcc, claimed }`,
mined assets (`kind: "pow"`, bigints as decimal strings, `dPts`, `claimsByHeight`), `kind` on every
asset, and `mine`, `mineAcc`, `claimed` in each undo entry. It is written once any activation is at or
below the height (or mining state exists); below that the version 2 layout above is written, because it
holds the whole state there. `restore()` accepts version 3 when every activation height equals the
caller's or both are `null` or above the snapshot height, and version 2 (digest version 1) when every
caller activation is `null` or above the snapshot height (assets become `kind: "mint"`, mining state
empty). Anything else throws `snapshot activations differ` or `unsupported snapshot version`; the
caller archives the file and resyncs. Before that, node and browser loaders (`Indexer.restoreRewound`)
take a snapshot written past an activation height the loading release pins (by the release before it):
restored under the table it was written with, it rolls back through its undo journal to the block
before the first height where the two tables differ, and the loader syncs from there under the new
rules. Below that height both tables give the same state, so this is a shortcut, not a rule; when the
journal does not reach back that far the file is archived and resynced.

## 13. Out of MVP scope
- Outgoing viewing key.
- View tags for fast scanning.
- Witness carrier (−40% vB).
- Other arities.
- What header verification (section 16) cannot do: a data source can still withhold blocks or a
  better chain, or delay them; the signet block signature (BIP325) is not checked (audit A-9).
- Mainnet proving key: a public phase-2 MPC ceremony on top of the public phase-1 transcript
  (tooling ready, docs/CEREMONY.md; open until it runs). Signet keeps its DEV single-party phase 2 in
  `build/dev` by design: its genesis ATTEST pins that manifest.

## 14. Relayer and relay timing (non-consensus)
The relayer (`docs/design/relayer.md`, `docs/design/batch-contract.md`, `docs/design/relay-balance.md`,
`docs/design/relay-balance-contract.md`) is not part of the protocol. Nothing in this section changes what an indexer accepts or rejects (§6), and
no rule depends on who carried an envelope.

- **There is no free mode.** The free relayer ("Ghost Relay"), which paid carriers from the operator's
  BTC, is retired: anyone could drain it with zero-value transfers, which need no tokens (audit R-2).
  A sender pays the fee from their own address (the default), or copies the envelope for anyone to
  carry. A server without a relayer answers `enabled: false` on `GET /api/relay/info` and 503 `disabled`
  on `POST /api/relay/submit`, and a relay id of the old relayer answers `dropped` unless it was
  already accepted.
- **Relaying is paid from a prepaid relay balance**, an option the user turns on by topping up. The
  user pays a fresh deposit address with a plain BTC payment; after the deposit confirmations (1 on
  signet, 3 on mainnet) the relayer credits it, less the cost of later spending that coin. Each relayed
  send is charged its exact carrier fee plus a margin, before the carrier is signed. The operator never
  pays any part of a user's transaction.

### 14.1 Relay balance (non-consensus)
- **Account.** A wallet derives its relay account secret with HKDF-SHA256 from its 32-byte seed, info
  label `murkle/relay-account/v1/<network>` (`signet`, `testnet` or `mainnet`), so accounts differ per
  network. The public key is the BIP340 x-only key; the account id is `sha256(pub)`.
- **Deposit addresses.** The relayer publishes a pool key `Q` (x-only). Deposit address `n`
  (`0 ≤ n ≤ 2^31 − 1`) of account `id` is the key-path P2TR address whose internal key is
  `lift_x(Q) + t·G` with `t = int(taggedHash("murkle/relay-deposit/v1", Q ‖ id ‖ u32be(n))) mod N`.
  Only the relayer can spend it; any wallet can pay it, with no OP_RETURN. The wallet shows address `n`
  until it is paid, then `n + 1`; payments to older addresses are still credited.
- **Outpoints** are written as 64 lowercase hex characters, `:`, and the output number in decimal with
  no sign, spaces or leading zeros, at most 4294967295 (`^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$`). Any other
  spelling is refused, so one output has one key and is credited at most once.
- **Signed requests.** The balance read and the submit carry `accountPub`, `t` (Unix seconds, within
  600 s of the relayer's clock) and `sig`, a BIP340 signature over
  `taggedHash("murkle/relay/v1", lp(endpoint) ‖ lp(network) ‖ Q ‖ sha256(canonical body))`, where
  `lp(s)` is one length byte then the UTF-8 bytes, and the canonical body is the JSON of every field
  except `sig` with keys sorted and no whitespace. A submit's body holds `envelope` and `mode`, so a
  copied signature cannot carry another envelope or timing. A credit is not signed: it can only credit
  a deposit to the account it pays.
- **I-PAY.** Every satoshi the relayer spends as a miner fee is covered by user money that was
  deposited, confirmed and credited to the account that caused the spend (or by margins, for its own
  housekeeping), before the signature is released. It signs only credited deposits and outputs of its
  own journaled transactions (I0), charges the exact fee from the final transaction's amounts before
  signing (I1), and stops itself when its books do not add up (I2). `docs/design/relay-balance-contract.md`
  §3 names the enforcing functions; audit R-3 records the invariant.

### 14.2 Relay timing
A relay submission names one of four timings:

| Mode | Shown as | Anchor | Sent by the relayer |
|---|---|---|---|
| `block` (default) | Next block | the tip when proved | at the next block |
| `fast` | Fast | the tip when proved | at once, after acceptance |
| `batch` | Hourly batch | the epoch start S, `S % 6 = 0` | once its indexer reaches S + 6 (lands at about S + 7) |
| `batch10` | 10-hour batch | the epoch start S, `S % 60 = 0` | once its indexer reaches S + 60 (lands at about S + 61) |

- Epochs are absolute heights, the same for every wallet: an Hourly batch epoch starts at every height
  divisible by 6, a 10-hour epoch at every height divisible by 60. The lengths are fixed constants
  (`src/relay-batch.mjs`), not relayer settings. The 10-hour batch replaced a 12-hour batch of 72 blocks
  on 2026-10-03 (`docs/design/privacy-level2.md` §9); `batch12` is not a mode.
- A batch envelope is an ordinary TRANSACT (§5) whose anchor is S instead of the tip: the wallet proves
  against the tree as it stood after block S, so it spends only notes that existed then, and the proof
  holds against R[S]. §6 checks it like any other envelope: it is valid while `H−100 ≤ S ≤ H−1`.
- The relayer sends an epoch on time, and gives up after block S + 100 − safety (safety 24 for the
  Hourly batch, 12 for the 10-hour batch: S + 76 and S + 88), so the carrier can still confirm before
  S + 100. An item its relay balance or the fee cap cannot pay at release becomes `missed` (nothing is
  charged) while the rest of its epoch goes out; the epoch is held whole only when the relayer cannot
  send at all. Above the fee cap, Next block and Fast are refused at once, never held. Wallet invariant W-1 is unchanged: the notes stay reserved until the transfer
  lands or until block S + 100.
- An Hourly and a 10-hour batch with the same S land about 54 blocks apart: they are separate crowds.
  The relayer still sees the IP address and the time of every submission. It publishes each batch's
  waiting count once per block, so anyone can still tell which block a batch transfer was submitted in.

## 15. Mining: DEPLOY_POW (op 0x09), MINE (op 0x07), MINE_SCRIPT (op 0x08)
A second way to issue a token: proof-of-work claims whose reward goes to a private note. Design and
reasoning: `docs/design/mining.md`; binding build rules: `docs/design/mining-contract.md`. Every rule
here applies only at and above the `mining` activation height (section 9), which is `null` in this
release: on the live chain ops 7, 8 and 9 are `malformed: unknown op N` (section 6, rule 1). No circuit
change and no new setup: a MINE proof has the MINT shape.

Constants (`src/params.mjs`, consensus): `MINE_WINDOW = 12`, `STALE_FACTOR = 4`, `MIN_DIFFICULTY = 256`,
span 12 … 432, `16 ≤ targetPerSpan ≤ 100 × span`, `D_MAX = 2^63 − 1`, label
`murkle/mine/v1`, Argon2 salt `murkle/mine/salt`, Argon2id version 0x13, m = 4096 KiB, t = 1, p = 1,
tag 32 bytes, no secret, no associated data. Service fee (`MINE_FEE`, per network): on signet
500 sats per claim to the platform script
`51203084846915ba86451221466028377de3bcf2ad8dc19ab8137684407dba6a9bab` (P2TR, an operator key), and
no deployer fee (`deployerMinSats = deployerMaxSats = 0`). A change of these constants is a new rule
with its own activation height. The fee recipient's own claims pay the fee back to itself, so it mines
500 sats cheaper per claim.

### DEPLOY_POW (op = 0x09), no proof, 66 bytes + ticker + treasury (67 … 116)
| Field | Type and rule |
|---|---|
| ticker | u8 length + ASCII `[A-Z0-9]{1,16}`; one namespace with DEPLOY: the first valid DEPLOY or DEPLOY_POW claims it |
| divisibility | u8, ≤ 8 |
| reward | u64 LE, 1 … 2^63 − 1 (MINE carries it as i64) |
| maxSupply | u64 LE, ≥ reward |
| halvingInterval | u32 LE, blocks, 0 = no halving |
| span | u16 LE, 12 … 432 |
| targetPerSpan | u32 LE, 16 … 100 × span |
| initialDifficulty | u64 LE, minDifficulty … 2^63 − 1 |
| minDifficulty | u64 LE, ≥ 256 |
| claimFeeSats | u64 LE, deployer fee per claim; > 0 needs a treasury |
| treasury | u8 length + scriptPubKey: empty, or exactly P2PKH, P2SH, P2WPKH, P2WSH or P2TR |
| startHeight / endHeight | u32 LE / u32 LE, startHeight 0 = mining opens at the deploy block / endHeight 0 = unbounded; endHeight ≠ 0 needs endHeight ≥ startHeight |

Breaking a rule of the table (or trailing bytes) is `malformed: …`. The indexer then requires, in
order: the fee policy (with this release's constants any `claimFeeSats ≠ 0` is
`malformed: deployer claim fee not allowed`), `endHeight = 0` or `endHeight ≥ mineStart`
(`malformed: end before mining start`), and an unclaimed ticker. Asset id as for DEPLOY;
`mineStart = max(startHeight, deployHeight)`: there is no lead, so with startHeight 0 (or any height at
or below the deploy block) the first usable reference block is the deploy block itself, whose hash
nobody knows before it is mined, and no reference before the deploy block is ever valid. A later
startHeight delays the start (the wallet and the CLI offer "now" or "after N blocks", encoding the
second as tip + 1 + N). MINT and MINT_SCRIPT against a mined asset are
rejected (`asset is mined`); MINE against a paid-mint asset is rejected (`asset is not mined`).

### MINE (515 bytes) and MINE_SCRIPT (511 bytes)
The TRANSACT body with `anchor = refHeight`, then `bindOutpoint` (36, MINE) or `bindScriptHash` (32,
MINE_SCRIPT) right after `publicAmount`, then an 8-byte `nonce`, then the nullifiers, commitments,
ciphertexts and the proof. `extDataHash = sha256(body) >> 8` covers the bind and the nonce.

```
challenge  = sha256("murkle/mine/v1" ‖ asset u64 LE ‖ refHeight u32 LE ‖ refHash 32 ‖ reward u64 LE ‖ c0 32 BE ‖ c1 32 BE)
password   = challenge ‖ nonce                    (40 bytes)
powHash    = Argon2id(password, "murkle/mine/salt", m = 4096 KiB, t = 1, p = 1, v = 0x13, 32 bytes)
solutionId = sha256(password)
valid      ⇔ int_BE(powHash) ≤ floor((2^256 − 1) / D_eff)
D_eff      = max(D(refHeight), floor(D(H − 1) / 4))           (H = inclusion height)
```
`refHash` is the 32 bytes of the display hex of block `refHeight` from the replay's own chain.

Checks, in this order, all before any mutation (the first failure is the reason):
1. activation gate, strict decoding (section 6, rule 1);
2. `unknown asset`; `asset is not mined`;
3. `H − 12 ≤ refHeight ≤ H − 1` (`reference outside window`); `refHeight ≥ mineStart` (`mining not
   started`); `endHeight = 0` or `refHeight ≤ endHeight` (`mining closed`);
4. the replay knows the hash of `refHeight` (`unknown reference block`);
5. `r = reward(refHeight) > 0` (`mining ended`) and `publicAmount = r` (`reward differs from terms`),
   where `reward(ref) = reward >> floor((ref − mineStart) / halvingInterval)` (no halving when the
   interval is 0; 0 once the shift reaches 63);
6. `issued + r ≤ maxSupply` (`supply cap reached`); claims are processed in block order;
7. service fee: for each required fee script (the treasury with `claimFeeSats` when it is > 0, then the
   platform script with `platformSats` when it is > 0; equal scripts grouped and summed), the gross sum
   of the carrier's outputs paying it is at least the amount
   (`underpaid service fee: P < N sats to <script hex>`);
8. bind, cheap part: MINE needs first input = `bindOutpoint` (`MINE not bound to this transaction`);
   MINE_SCRIPT needs a first input that is not the null outpoint (`MINE not bound to this payer`);
9. nullifiers distinct and not in `N` (`duplicate nullifier in envelope`, `nullifier already spent`);
10. `solutionId` not already claimed (`solution already claimed`);
11. the work: `powHash` meets `D_eff` (`insufficient work`);
12. proof decoding and Groth16 with `[R[refHeight], reward, asset, extDataHash, n0, n1, c0, c1]`;
13. MINE_SCRIPT: the first input spends an output whose scriptPubKey hashes to `bindScriptHash`, read
    as for MINT_SCRIPT (`MINE not bound to this payer`).

Invalid work never reaches a pairing check, and a prevout lookup needs a valid proof. **Errors are never
verdicts:** an Argon2 evaluation that throws, a worker that dies or times out, and a failed lookup abort
the block, which is reverted through the journal and retried (section 6, rule 10). Each distinct
`solutionId` is evaluated at most once per block; a replayer may first evaluate, in parallel, the
claims that pass rules 2 to 8 and whose nullifiers and solution are unused at the start of the block.

Apply: commitments to the tree and the outputs (wallets find the reward by trial decryption),
nullifiers to `N`; `claims += 1`, `issued += r` (`pool = issued`), `feeSats` += the fee outputs paid;
the block's work for the asset grows by `D_eff`; `solutionId` joins the claimed set and `mineAcc`.
A rejected claim of a mined asset changes nothing but `rejectedClaims` and `burnedFeeSats` (the fee
outputs it paid). The reference implementation of every rule above is `src/mine.mjs` and
`src/indexer.mjs`. Argon2 is `hash-wasm` 4.12.0 after its self-test in each process or worker, with
`@noble/hashes` as the reference and fallback; on the server it runs in a worker pool, never on the
event loop.

### Difficulty
`D(h) = initialDifficulty` for `h ≤ mineStart`. After every block `h > mineStart`, with `τ = span`,
`S = targetPerSpan` and `w` the asset's counted work in that block:
`D(h) = min(D_MAX, max(minDifficulty, floor((D(h − 1)·(τ − 1)·S + w·τ) / (τ·S))))`, all integers.
Only blocks with claims store a point `[h, D(h)]` (in `dPts`, starting at `[mineStart, initialDifficulty]`);
`D` at any other height is the `w = 0` step iterated from the newest point at or below it. At the end of
each block, inside the block's revert scope, the points are appended and each touched asset keeps only
the newest point at or below `H − 13` and those after it; solutions with `refHeight < H − 156` leave
the claimed set (no claim can reference them any more, and a rollback is at most 144 blocks). The
journal restores every mining field, `dPts`, `mineAcc` and the claimed set.

What this does not promise: a GPU or a server miner can be thousands of times faster than a browser
tab, and anyone can rent many computers; Bitcoin miners choose what goes into blocks and in what order
and can delay a claim until it expires; with few solutions per span, emission runs a few percent above
target, and after a quiet period or a hashrate jump the first block can carry many claims.

## 16. Chain data and header verification (non-consensus)

Where the block data comes from never changes a verdict: header verification only accepts or refuses
blocks from the data source and never alters their bytes, so for any block sequence it accepts the
verdicts and digests are exactly those of a replay without it. It stops the indexer (no verdict) when a
header fails. Design: `docs/design/mainnet-readiness.md` section 3.

**Data sources.** `MURKLE_BTC_SOURCE=esplora` (the default: mempool.space, or `MURKLE_ESPLORA`) or
`bitcoind` (the operator's own Bitcoin Core over JSON-RPC, `MURKLE_BITCOIND_URL` with a cookie file or a
password file; Core needs `txindex=1`, so it cannot be pruned). Every consensus input is fetched as raw
bytes and checked against its hash (blocks against their header, transactions against their txid).

**What is verified**, by the server, the CLI and the browser's pool replay, from a pinned checkpoint
(`src/btc/checkpoints.json`: the Murkle genesis block of each network, plus optional later ones) upward:
- linkage: each header's previous-block hash is the hash of the header below it;
- proof of work: `hash <= target(nBits)` with Bitcoin Core's compact-target rules (negative, zero,
  overflowing or above-`powLimit` targets are invalid);
- the difficulty rule: `nBits` is unchanged inside a 2016-block period and, at a period boundary, equals
  Core's retarget of the previous period (timespan clamped to a quarter and four times two weeks, capped at
  `powLimit`, compared exactly after re-encoding);
- timestamps: above the median of the previous 11; at most two hours ahead of the local clock (a header
  beyond that is retried later, never rejected for good);
- versions above the BIP34 / BIP66 / BIP65 heights;
- checkpoints: a header at a checkpoint height must have the pinned hash;
- most work: when the source serves another block at a height already verified, the new branch is accepted
  only with strictly more cumulative work than the branch held (the first-seen branch wins a tie);
  otherwise the indexer is not rolled back and reports `less-work`. When the header file lags the indexer's
  state, the indexer's own blocks are fetched by hash and verified first, so alignment alone never moves the
  indexer to another branch; only when the source cannot serve them is the indexer realigned to the source.
  The header file is saved before the state file.

**What is still trusted.** A single data source can withhold blocks or a better chain, or delay them. For the
chain the indexer verifies from a checkpoint it cannot forge mainnet proof of work cheaply. Running your own node (the `bitcoind` source) removes that third
party; a browser cannot do that. On **signet**, a block is valid because of the signet operator's signature
(BIP325), which is **not** checked, and signet proof of work is nearly free, so there the check mainly
catches broken or inconsistent data. Blocks below the base checkpoint are not header-checked (nothing
Murkle uses is there). Header verification can be turned off only on signet (`MURKLE_HEADERS=off`); on
mainnet it is always on.

**Receipts.** A browser receipt checks the header of the transaction's block from what it fetches: against
the user's own verified replay chain when that covers the height, else by a short run of linked headers above
it, else by a lower bound on its work from the pinned checkpoint, and says which level applied. The data
source names the block's height, so the receipt refuses a height above what an honest chain from the
checkpoint can have reached by the local clock (one block per 10 minutes, 25% faster, plus 2016 blocks), and a
header at a pinned checkpoint height must have the pinned hash. The bound allows 4x easier targets per
retarget period away from the checkpoint, so it weakens with distance: the receipt prints the least work the
checked headers needed (about 2^N hashes) and says the source "cannot cheaply forge proof of work" only when
that is at least 2^72 (or the replay verified the header); otherwise it says the bounds are weak there. Each
release therefore ships a recent mainnet checkpoint (docs/MAINNET.md).

**Relay deposits.** On mainnet the paid relayer credits a deposit only from a block the indexer applied
(header-verified) at the height the source names, with the transaction proven inside it (a merkle path to that
block's header, else the raw block), and counts its confirmations from the indexer's height, never from the
source's tip; credited deposits are re-checked the same way while they are shallow.

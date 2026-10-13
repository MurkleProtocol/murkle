# Mainnet launch checklist

Status: **Murkle has not launched on Bitcoin mainnet.** No mainnet genesis is pinned
(`src/pins.mainnet.json` has `genesisTxid: null`), the mainnet proving key does not exist until the operator
makes it (`npm run key:mainnet`), and mining on mainnet starts only once a mining height is pinned (G5). Signet stays the
default network and keeps running unchanged.

This file is the exact order of the launch, with the command and the evidence for each step, what only the
owner can provide, and the go/no-go list. Design and interfaces: `docs/design/mainnet-readiness.md`. Running
the servers: `docs/OPERATIONS.md`.

Owner decisions of 2026-10-13: the mainnet node runs on a small VPS with chain data from mempool.space (no own
Bitcoin Core at launch), the platform fee is 500 sats per mining claim, and the launch goes ahead without an
external audit.

Contents: 1. How the network is selected · 2. What the owner must provide · 3. Launch sequence (G0 to G8) ·
4. Go/no-go list · 5. After launch · 6. What stays open

---

## 1. How the network is selected

- `MURKLE_NETWORK=mainnet` for the server, the CLI and every script; the web app is built with
  `MURKLE_NETWORK=mainnet` (the value is fixed at build time and written to `web/dist/murkle-build.json`; the
  indexer refuses to serve a web build made for another network). Unset or empty means `signet`; anything else
  refuses to start.
- Mainnet uses `src/pins.mainnet.json`, the artifacts in `build/mainnet/`, the data directory `data/mainnet/`,
  shielded addresses `murk1…`, Bitcoin addresses `bc1…`, network-separated wallet keys
  (`murkle/mainnet/<name>`), and the strict ticker rule (V2-02) from genesis. See SPEC.md section 1.1.
- Before genesis on mainnet: the server refuses to start (except `MURKLE_ALLOW_PRE_GENESIS=1` for a staging
  run, and never with an unpinned verification key); the CLI runs only `new`, `address`, `address-script`,
  `attest genesis` and read-only commands; the web app shows `MAINNET · NOT LAUNCHED` and disables every
  action that would move funds (creating or importing a wallet still works).
- Header verification (SPEC.md section 16) is always on for mainnet; `MURKLE_HEADERS=off` refuses there.

## 2. What the owner must provide

| Item | Why | Where it goes |
|---|---|---|
| Platform address (P2TR recommended). Given by the owner on 2026-10-13: `bc1pa4dr4q6h8nq6ky8rgy52y8engygf8n0exag4vnk4l7stwm20q8vq5fxumn`. The fee is decided: 500 sats per mining claim (owner decision 2026-10-13) | The consensus service-fee rule of mining. Done: `MINE_FEES.mainnet` holds this address (script `5120ed5a3a83573cc1ab10e34128a21f33411093cdf93751564ed5ffa0b76d4f01d8`, `platformSats: 500n`). Mining still starts only when a mining height is pinned (step G5) | `MINE_FEES.mainnet` in `src/params.mjs` (check in step G5) |
| Servers | Decided (owner, 2026-10-13): one small VPS, 2 vCPU, 4 GB RAM, 40 GB SSD, chain data from mempool.space (`MURKLE_BTC_SOURCE=esplora`, the default). No own Bitcoin Core at launch | `docs/OPERATIONS.md` |
| Domain and TLS | HTTPS for the site and the API. The owner has rented a domain (the name is not known yet); it goes into `SITE_DOMAIN` (and `MURKLE_PUBLIC_URL`) at deploy time | `deploy/caddy/Caddyfile` or `deploy/nginx/murkle.conf` |
| Bitcoin Core 30 or later (optional, not used at launch) | An own node would remove the third-party data source (A-9: mempool.space can hide or delay blocks) and the dependence on its availability and rate limits, and would put the OP_RETURN relay policy under your control (Core 30's default `datacarriersize` relays the 471-515 byte OP_RETURN carriers; older or filtering nodes do not). It needs a bigger host (4+ vCPU, 16 GB RAM, 1.5 TB+ SSD for an unpruned node with `txindex=1`). Switching later is one setting | `deploy/bitcoin/bitcoin.conf.example`, `MURKLE_BTC_SOURCE=bitcoind` |
| Security contact and the public repository URL | Users must be able to report bugs privately and read the source | `SECURITY_CONTACT`, `REPO_URL` in `src/params.mjs` |
| The offline backup key | The relayer holds users' prepaid deposits; its keys and books are backed up encrypted to this key | `deploy/bin/backup.mjs keygen` on an offline machine |
| A clean machine for the mainnet key | The operator makes the key once with `npm run key:mainnet` | step G1 |
| The mainnet genesis ATTEST, paid from the owner's own funds | It is the platform's transaction (a few thousand sats), never a user's | step G4 |
| An external audit, or an explicit decision to launch without one | Decided (owner, 2026-10-13): launch without an external audit. Every surface keeps saying "no external audit yet" | `audit/`, the site copy |

## 3. Launch sequence

Each step names its evidence. Do them in order; a step that fails stops the launch.

### G0. Code freeze

```bash
git tag -s vX.Y.Z            # the release that will run mainnet; needs a GPG or SSH signing key and writes the tag to this repository
npm test
# Signet replay identity (mainnet-readiness.md §7): a copy of the live state, never the original
cp data/signet/state.json /tmp/signet-state.json
node scripts/replay-compare.mjs --network signet --snapshot /tmp/signet-state.json --out /tmp/replay-on --cache /tmp/replay-cache --headers on
node scripts/replay-compare.mjs --network signet --snapshot /tmp/signet-state.json --out /tmp/replay-off --cache /tmp/replay-cache --headers off
```

Preconditions:

- Optional: `node_modules/.cache/murkle-pre-mining/src`, a hand-made copy of the `src/` that predates mining
  (`docs/design/mining-contract.md` section 7.2). The copy that was kept there was lost on 2026-10-13 and
  cannot be re-created (this repository's history starts after mining landed). Without it the pre-mining
  comparison tests in `test/mine-e2e.test.mjs` and `test/mine-indexer.test.mjs` skip, and `npm test` can
  still print green. The identity evidence for G0 is the signet replay below (headers on and off, "identical
  through H"); the 2026-10-13 rehearsal passed it: identical through 325958, 1367 blocks, strictFailures 0.
- The replays need the signet artifacts in `build/dev/` (`npm run artifacts:fetch`; without them they stop at
  once with "build/dev/verification_key.json is missing"), a copy of the live `data/signet/state.json`, network
  access to the signet source, and `MURKLE_NETWORK` unset or `signet`. A replay takes a few minutes (about
  4 minutes with headers on and a cold cache).

Evidence: `npm test` green (the pre-mining comparison tests may skip, see above); both replays print
`identical through H`; the V2-02 count is zero.

### G1. Mainnet key

The mainnet key is single-party by owner decision of 2026-10-11; a later key change would need a consensus
activation and is not planned. Run `npm run key:mainnet` on a clean machine at launch, publish the key files in
a release and pin their sha256 in `src/pins.mainnet.json`; the genesis ATTEST pins that manifest.

On a clean machine, with this release checked out, `npm ci` done, circom 2.2.2 on the PATH and the pinned
`build/ptau/powersOfTau28_hez_final_15.ptau` in place (the tool checks its size, sha256 and blake2b before it
uses it):

```bash
# The same circuit as signet: compile into build/ (do NOT run npm run circuit:build; it would make a new signet key)
circom circuits/transaction.circom --O2 --r1cs --wasm --sym -o build
npm run key:mainnet        # one contribution, in process; writes build/mainnet/{transaction.zkey, verification_key.json, manifest.json}
npm run key:verify -- --network mainnet
```

`key:mainnet` refuses to run when `build/mainnet/` already holds a key (`--force-new` moves it aside, only
before genesis). It verifies the new key against the r1cs and the phase-1 file before it writes anything, and it
prints the sha256 values for G2. Run it once, close the terminal afterwards, and do not copy the process
memory, a core dump or a swap file anywhere. Evidence: the printed manifest hash and contribution hash; at
least one person outside the project ran `npm run key:verify` on the published files and published its output.

### G2. Artifacts

Put the values `key:mainnet` printed into `src/pins.mainnet.json` by hand: `manifestSha256`, `artifacts.zkey`
and `artifacts.vkey` (`artifacts.wasm` is already pinned; leave `genesisTxid`, `activationHeight` and
`activations` as they are). Then:

```bash
MURKLE_NETWORK=mainnet npm run artifacts:check
npm run key:verify -- --network mainnet --require-pins
MURKLE_NETWORK=mainnet npm run release:assets -- --out /tmp/murkle-mainnet-assets
```

Publish the key files (`transaction.zkey`, `verification_key.json`, `manifest.json`) in a release under the
release tag of the mainnet manifest. The genesis ATTEST (G4) pins that manifest. The release notes that
`release:assets` writes now say "(not pinned)" for the genesis txid and the activation height: re-run it after G4 and
update the release body. Evidence: the artifact check
and `key:verify` pass against the pins; `src/pins.json` is byte-identical to the previous release.

### G3. Header checkpoint

With no own node at launch, cross-check two independent Esplora APIs. `scripts/checkpoint.mjs` has no
URL flag: it opens the chain source from the environment, so `--source esplora` selects the Esplora source
and `MURKLE_ESPLORA` sets the API root (default: `https://mempool.space/api` on mainnet). It prints the
checkpoint on stdout and `source: <API root>` on stderr.

```bash
export MURKLE_NETWORK=mainnet
MURKLE_ESPLORA=https://mempool.space/api    node scripts/checkpoint.mjs --network mainnet --height <recent multiple of 2016> --source esplora > /tmp/cp-mempool.json
MURKLE_ESPLORA=https://blockstream.info/api node scripts/checkpoint.mjs --network mainnet --height <same height> --source esplora > /tmp/cp-blockstream.json
diff /tmp/cp-mempool.json /tmp/cp-blockstream.json && echo identical
```

Both outputs must be identical; commit the entry to `src/btc/checkpoints.json`. Each run checks linkage,
proof of work, the difficulty bits and the median time past over the headers it reads, so a wrong hash would
have to be served consistently by both operators. Evidence: the two outputs, the two `source:` lines, and the
block hash compared by hand with a third explorer. If an own node exists later, run it a third time with
`--source bitcoind` (and `MURKLE_BITCOIND_URL` / `MURKLE_BITCOIND_COOKIE`).

### G4. Genesis

From the owner's own wallet, on a machine you trust (the CLI wallet file holds plaintext keys):

```bash
export MURKLE_NETWORK=mainnet MURKLE_DATA_DIR=/secure/murkle-owner MURKLE_BTC_SOURCE=esplora   # the default; bitcoind only with an own node
node bin/murkle.mjs new owner                  # prints murk1… and the bc1p… fee address
# fund the bc1p… fee address now: about 1,500 sats or more (a measured dry run was 160 vB and 644 sats; the fee rate varies)
node bin/murkle.mjs attest genesis owner --dry-run
node bin/murkle.mjs attest genesis owner       # ATTEST kind 1 over manifestSha256
```

Without the funding the dry run stops with "not enough BTC … have 0 sats". Once the address is funded, the
dry run prints the full signed transaction in hex, and that hex can be broadcast by anyone who has it: do not
share or paste it anywhere.

After **6 confirmations**, pin it by hand in `src/pins.mainnet.json`:

```json
"genesisTxid": "<txid>",
"activationHeight": <its block height>
```

and add the genesis block as a second base checkpoint (`scripts/checkpoint.mjs --network mainnet --height
<activationHeight> --label "Murkle mainnet genesis (ATTEST <txid prefix>…)"`) to `src/btc/checkpoints.json`.
Evidence: the transaction at its height on two explorers (the Esplora source reads the chain from mempool.space, so
use a second, independent explorer such as blockstream.info); the server starts without
`MURKLE_ALLOW_PRE_GENESIS`; `GET /api/state` shows `genesis` and no `warning`.

`src/pins.mainnet.json` already holds `"reservedTickers": { "MURK": null }` before the genesis is broadcast, so
the ticker `MURK` is reserved in every build from the first release (see G5b). Keep that line. For the MURK launch the
genesis fields, the mining height (G5) and the reserved-ticker pin are set in one release (G5b).

### G5. Mining (optional at launch)

```bash
MURKLE_NETWORK=mainnet node bin/murkle.mjs address-script bc1pa4dr4q6h8nq6ky8rgy52y8engygf8n0exag4vnk4l7stwm20q8vq5fxumn   # murkle address-script: prints the scriptPubKey hex
```

The platform address was given by the owner on 2026-10-13 and is already set in `src/params.mjs`
(`bc1pa4dr4q6h8nq6ky8rgy52y8engygf8n0exag4vnk4l7stwm20q8vq5fxumn`). Check that the output above is
`5120ed5a3a83573cc1ab10e34128a21f33411093cdf93751564ed5ffa0b76d4f01d8` for that address and that
`MINE_FEES.mainnet` holds the same script, with nothing to edit:

```js
mainnet: feeRule({ hrp: "bc", platformScript: "5120ed5a3a83573cc1ab10e34128a21f33411093cdf93751564ed5ffa0b76d4f01d8", platformSats: 500n,
  deployerMinSats: 0n, deployerMaxSats: 0n }),
```

The platform fee is 500 sats per claim (owner decision 2026-10-13). Then pin a mining height above the genesis height in `src/pins.mainnet.json` (`activations[0].height`), in a
release. For the MURK launch the height is genesis + 1, already in the past when the release is cut, and G5b explains
why that is safe (and why the reserved ticker rule is needed); any other launch pins a future height. Without a pinned mining height mining stays off. A rule that is a placeholder (no script) is still refused: the
server and the CLI say "mining is not configured on mainnet", and an indexer with a mining height and such a
rule refuses to start. Evidence: `npm test`; `mineFeeReady()` returns null with `MURKLE_NETWORK=mainnet` exported (without it the function checks signet and
returns null whatever the mainnet rule says).

#### G5b. The MURK launch (owner decision 2026-10-13; nothing here is broadcast until the owner runs it)

The owner deploys the mined token MURK on mainnet right after the genesis. The ticker namespace is shared with
plain `deploy`: the first valid DEPLOY or DEPLOY_POW in block order owns the ticker, and nobody can take it back.
Because a plain DEPLOY counts from the genesis block while a DEPLOY_POW counts only from the mining height
(genesis + 1), anyone who sees the genesis ATTEST in the mempool could deploy `MURK` first, and no fee rate would
prevent it. So `MURK` is a **reserved ticker** (SPEC.md section 7, security audit M1): `src/pins.mainnet.json` holds
`reservedTickers.MURK`, every node rejects every deploy of `MURK` except the one carrier transaction pinned there,
and the pin is `null` (nothing is valid) until the operator pins the txid of its own signed deploy, which it
broadcasts only after that release is deployed.

| Term | Value | Check against SPEC.md section 15 and `src/mine.mjs` |
|---|---|---|
| ticker | `MURK` | 1 to 16 characters of A-Z0-9, raw bytes (strict ticker on mainnet) |
| divisibility | 8 | at most 8 |
| reward per claim | 1000 MURK = `100000000000` base units | 1 to 2^63 - 1 |
| maxSupply | 21,000 claims x 1000 = 21,000,000 MURK = `2100000000000000` base units | at least the reward, below 2^64, an exact multiple of the reward, so the last claim fits exactly |
| halvingInterval | 0 | none |
| span | 12 blocks | the minimum (12 to 432) |
| targetPerSpan | 1200 (`--per-block 100` x span 12) | the maximum, 100 per block; the difficulty rises only when a block carries more than 100 claims on average |
| initialDifficulty = minDifficulty | 3,600,000 | at least 256, at most 2^63 - 1; equal, so the difficulty never falls below its start |
| claimFeeSats / treasury | 0 / empty | the mainnet fee policy allows no deployer fee (`deployerMaxSats = 0`) |
| startHeight / endHeight | 0 / 0 | mining opens at the launch block itself (`--start now`); no end block |

Expected time per solution is the difficulty divided by the hash rate (one hash in 3,600,000 meets the target).
At 1,000 H/s that is 3,600 s, about one hour, as intended. The measured figure for one `hash-wasm` browser thread
is 210 to 280 H/s (mining.md section 4.4, a Ryzen 9 7950X), so a single thread needs 3.6 to 4.8 hours and the
"about one solution per hour" holds for a tab with about 4 threads. One GPU (an estimate, not a measurement: roughly 80,000 to 120,000 H/s from the memory-bandwidth argument in mining.md
section 4.4) would find about 13 to 20 solutions per block and would mine out the supply in roughly 1,000 to 1,600
blocks (7 to 11 days). With the floor equal to the start, the difficulty only climbs once the network averages
more than 100 claims per block, about 600,000 H/s.

Exact commands, after the genesis is pinned (G4) and the owner wallet is funded for the launch (the carrier is
192 vB: about 3,900 sats at 20 sat/vB, about 19,000 sats at 100 sat/vB; use twice the next-block rate shown by
mempool.space, the CLI accepts `--fee-rate` up to 10,000):

The deploy's txid is pinned BEFORE the deploy is broadcast, so the public node knows MURK from its first block
and mining opens for everyone at once (security audit M-1: if the txid were pinned only after the deploy
confirmed, anyone adding the public txid to their own pins could mine MURK for hours while the public site showed
none). A taproot txid does not cover the signatures, so the txid of the signed transaction from the dry run is
the one that confirms, as long as that exact transaction is broadcast.

```bash
# 1. After the genesis has 6 confirmations, edit src/pins.mainnet.json in the checkout: genesisTxid,
#    activationHeight and the mining height (activations[0].height = <activationHeight> + 1). Keep
#    reservedTickers.MURK null for now: until step 3 nothing may be valid under that ticker.
# 2. The owner wallet (G4), never a scratch wallet:
export MURKLE_NETWORK=mainnet MURKLE_DATA_DIR=/secure/murkle-owner MURKLE_BTC_SOURCE=esplora
node bin/murkle.mjs sync                       # must reach the tip with the genesis pinned
# 3. Build the signed deploy without broadcasting it; keep its output in a file only the operator reads (anyone
#    holding the hex could broadcast it). MURK is reserved, so the CLI refuses it without --reserved-ticker (the
#    operator's own launch deploy; the flag skips no other check). Use a fee rate that confirms in the next block.
node bin/murkle.mjs deploy-pow owner --ticker MURK --reserved-ticker --divisibility 8 --reward 100000000000 --max-supply 2100000000000000 --span 12 --per-block 100 --difficulty 3600000 --min-difficulty 3600000 --halving 0 --claim-fee 0 --start now --end 0 --fee-rate <sat/vB> --dry-run > /secure/murkle-owner/murk-deploy.txt
#    The first line is "DEPLOY_POW (not broadcast): <txid> ..."; the second is the signed transaction.
# 4. Pin that txid as reservedTickers.MURK in src/pins.mainnet.json, run npm test, commit, cut the release and
#    deploy it (G6). Spend nothing from the owner wallet until step 5: the saved transaction spends its coin.
# 5. Broadcast exactly the saved transaction (never rebuild it: a new build may pick another fee or coin, and
#    a txid other than the pinned one is rejected for good). If it is slow, speed it up with a child transaction
#    that spends its change output, which keeps the txid; never replace it (RBF changes the txid).
curl -sS -X POST --data "$(sed -n 2p /secure/murkle-owner/murk-deploy.txt)" https://mempool.space/api/tx
#    Mining opens at the deploy block, for everyone at once.
node bin/murkle.mjs sync && node bin/murkle.mjs assets          # MURK, mining, 0/2100000000000000
```

What was checked before launch (2026-10-13): the exact values above are accepted by `deployPowTerms` and
`deployPowCommand` on the mainnet parameters (a fake chain view and a scratch key, nothing broadcast): they
print the terms above, build a 192 vB carrier with a 70-byte envelope, and decode back to the same fields. The CLI
cannot dry-run it on the real mainnet before the genesis: `deploy-pow` is refused while `src/pins.mainnet.json`
has no genesis ("has not launched on mainnet", the pre-genesis command list), and after the genesis it is
refused with "mining is not active" until the mining height is pinned (only `--dry-run` builds regardless).

Notes: step 1 pins a height that is already in the past when the release comes out. That is safe only while no
public mainnet indexer has served verdicts yet, because a replay with the release sees any DEPLOY_POW that landed
after the genesis as valid, except a DEPLOY or DEPLOY_POW of `MURK`, which the reserved ticker rule rejects until
step 5 (a squatter's `MURK` in the genesis block or at genesis + 1 stays rejected for good). Pin the txid that
actually confirmed: if the carrier was replaced (RBF) the first txid is not the one on chain. A saved indexer state that ran past the pin without it is rolled back to the block before the pin (when its
144-block undo journal reaches that far) or archived and re-synced from the genesis; the server does this on start. If the deploy
confirms but its txid is not pinned yet, `log` shows it as rejected with `ticker reserved`: that is expected; do not
broadcast a second deploy, pin the first. Check `assets` and the explorer before announcing anything.

### G6. Build and deploy

```bash
MURKLE_NETWORK=mainnet node scripts/facts.mjs --out /tmp/facts.json      # review the numbers first
MURKLE_NETWORK=mainnet node scripts/facts.mjs                            # regenerate in place: writes the tracked web/src/facts.mainnet.json
MURKLE_NETWORK=mainnet npm run web:build                                 # runs facts.mjs again, then vite build and the notices copy
cat web/dist/murkle-build.json        # { "network": "mainnet", "manifestSha256": "...", "genesisTxid": "..." }
```

Commit `web/src/facts.mainnet.json` in the release. A mainnet build without `web/dist/murkle-build.json` is
served as a signet build and the indexer answers 503 for it.

Install with `deploy/` on the small VPS (systemd units, `deploy/env/murkle.mainnet.env.example` with the Esplora
source, the reverse proxy with HTTPS for the rented domain, `MURKLE_CSP_ENFORCE=1`; no `bitcoind` service), start the monitor and the backups, and run the restore drill
(`docs/OPERATIONS.md`). The relayer does not run at launch (owner decision 2026-10-13): the launch server is a
rented host, and no key that holds users' funds is kept there; users pay their own fees. If it runs later, on a
host the operator controls, review its settings against current fee levels
(mainnet defaults: fee cap 50 sat/vB, 45,000 sats per transaction, minimum deposit 70,000 sats (its sweep plus two sends at the cap), margin floor
300 sats). Evidence: `GET /api/health?strict=1` answers 200 with `chainTip` not null and `preGenesis` false (a node
before genesis answers 200 too); the monitor prints `ok`;
a restored backup passes `deploy/bin/check-books.mjs`.

### G7. Smoke

- A browser replay of the pool from genesis matches the server's digest (the /verify page).
- Receipts for the genesis ATTEST show the header check level.
- One owner-paid private transfer lands and verifies in another browser.
- If the relayer runs: a small relay deposit is credited and one relayed send lands.
- One real mainnet carrier of each envelope size (471, 503/507, and 511/515 when mining is on) confirms, so
  the OP_RETURN relay policy of today's nodes is known (with the Esplora source the transactions are
  broadcast through mempool.space's nodes, so this is also the check of their policy).
- Stopping the indexer makes the monitor alert.

### G8. Announce

Honest copy (docs/CLAIMS.md): experimental software; tokens can be lost to bugs; internal review only unless an external
audit exists; headers are checked from a pinned checkpoint but a data source can still hide blocks; mints are
public; the anonymity set is small at first. Never call the system unbreakable or the users invisible.

## 4. Go/no-go list

Every line must be "go" before G8:

- [ ] Mainnet key made once on a clean machine (G1) and checked with `npm run key:verify` by at least one
      person outside the project.
- [ ] `src/pins.mainnet.json` complete (artifacts, manifest, genesis) and the served artifacts match it (G2, G4).
- [ ] Header verification on, from the pinned checkpoint with the Esplora source; the checkpoint cross-checked
      against two independent Esplora APIs (G3, G6). An own Bitcoin Core is optional and not part of the launch.
- [ ] One real mainnet carrier of each size confirmed before the announcement (G7).
- [ ] I-PAY review of the relayer settings at current fee levels: the operator never pays a user's fee, and
      there is no free mode.
- [ ] Backups encrypted, off-site, and a restore drill passed.
- [ ] Monitor alerts tested end to end.
- [ ] CSP enforced (`MURKLE_CSP_ENFORCE=1`).
- [ ] Security contact and repository published (`SECURITY_CONTACT`, `REPO_URL`).
- [ ] Copy review: nothing says mainnet runs before G4, no banned words (docs/CLAIMS.md).
- [ ] Launch without an external audit (owner decision 2026-10-13): the "no external audit yet" disclosure is on
      every surface.
- [ ] Signet stays up and unchanged.

## 5. After launch

- Checkpoints: ship a recent mainnet checkpoint (G3 procedure) with **every release**; it never changes a
  verdict. A receipt's difficulty bounds grow 4x per retarget period away from the nearest checkpoint, so about 4
  periods (two months) after the newest one, receipts that are not covered by the user's own replay say the
  bounds are weak instead of "cannot cheaply forge proof of work".
- The relayer's economics follow the fee market: raise or lower `MURKLE_MAX_FEE_RATE`,
  `MURKLE_MAX_FEE_PER_TX` and the deposit floor with the operator's own judgement, never below I-PAY.
- Any consensus change (a new fee rule, a new op) gets its own activation height in a release, at a future
  height, so no past verdict changes.

## 6. What stays open

- A-8: accepted risk, owner decision 2026-10-11 (single-party mainnet key). Signet keeps its DEV setup by
  design (its genesis pins it).
- A-9: a single data source can still withhold blocks or a better chain; the signet block signature (BIP325)
  is not checked. At launch the mainnet indexer reads from one third party, mempool.space (owner decision
  2026-10-13); headers are verified from the pinned checkpoint, so a forged chain is expensive, but hidden or
  delayed blocks are not detected, and an outage of mempool.space stops the sync (the API keeps serving the last state). The
  upgrade is an own Bitcoin Core node and `MURKLE_BTC_SOURCE=bitcoind` (docs/OPERATIONS.md 3.4); a browser
  still reads from mempool.space either way.
- No external audit yet (owner decision 2026-10-13: the launch goes ahead without one).

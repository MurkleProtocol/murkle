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
release, at a future height. Without a pinned mining height mining stays off. A rule that is a placeholder (no script) is still refused: the
server and the CLI say "mining is not configured on mainnet", and an indexer with a mining height and such a
rule refuses to start. Evidence: `npm test`; `mineFeeReady()` returns null with `MURKLE_NETWORK=mainnet` exported (without it the function checks signet and
returns null whatever the mainnet rule says).

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

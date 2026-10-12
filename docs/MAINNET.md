# Mainnet launch checklist

Status: **Murkle has not launched on Bitcoin mainnet.** No mainnet genesis is pinned
(`src/pins.mainnet.json` has `genesisTxid: null`), the mainnet proving key does not exist until the operator
makes it (`npm run key:mainnet`), and mining on mainnet is off until the owner names the platform address. Signet stays the
default network and keeps running unchanged.

This file is the exact order of the launch, with the command and the evidence for each step, what only the
owner can provide, and the go/no-go list. Design and interfaces: `docs/design/mainnet-readiness.md`. Running
the servers: `docs/OPERATIONS.md`.

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
| Platform address (P2TR recommended) and the platform fee amount per mining claim | The consensus service-fee rule of mining. The code holds the placeholder `TODO_PLATFORM_ADDRESS` and refuses to mine until it is replaced | `MINE_FEES.mainnet` in `src/params.mjs` (step G5) |
| Servers | Indexer host: 4+ vCPU, 16 GB RAM, 1.5 TB+ SSD for an unpruned Bitcoin Core with `txindex=1`. | `docs/OPERATIONS.md` |
| Domain and TLS | HTTPS for the site and the API | `deploy/caddy/Caddyfile` or `deploy/nginx/murkle.conf` |
| Bitcoin Core 30 or later | Your own node removes the third-party data source (A-9); Core 30's default `datacarriersize` relays the 471-515 byte OP_RETURN carriers, older or filtering nodes do not | `deploy/bitcoin/bitcoin.conf.example`, `MURKLE_BTC_SOURCE=bitcoind` |
| Security contact and the public repository URL | Users must be able to report bugs privately and read the source | `SECURITY_CONTACT`, `REPO_URL` in `src/params.mjs` |
| The offline backup key | The relayer holds users' prepaid deposits; its keys and books are backed up encrypted to this key | `deploy/bin/backup.mjs keygen` on an offline machine |
| A clean machine for the mainnet key | The operator makes the key once with `npm run key:mainnet` | step G1 |
| The mainnet genesis ATTEST, paid from the owner's own funds | It is the platform's transaction (a few thousand sats), never a user's | step G4 |
| An external audit, or an explicit decision to launch without one | A go/no-go item; without an audit every surface keeps saying "no external audit yet" | `audit/`, the site copy |

## 3. Launch sequence

Each step names its evidence. Do them in order; a step that fails stops the launch.

### G0. Code freeze

```bash
git tag -s vX.Y.Z            # the release that will run mainnet
MURKLE_PRE_MINING_SRC=node_modules/.cache/murkle-pre-mining/src npm test
# Signet replay identity (mainnet-readiness.md §7): a copy of the live state, never the original
cp data/signet/state.json /tmp/signet-state.json
node scripts/replay-compare.mjs --network signet --snapshot /tmp/signet-state.json --out /tmp/replay-on --cache /tmp/replay-cache --headers on
node scripts/replay-compare.mjs --network signet --snapshot /tmp/signet-state.json --out /tmp/replay-off --cache /tmp/replay-cache --headers off
```

Evidence: `npm test` green; both replays print `identical through H`; the V2-02 count is zero.

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
release tag of the mainnet manifest. The genesis ATTEST (G4) pins that manifest. Evidence: the artifact check
and `key:verify` pass against the pins; `src/pins.json` is byte-identical to the previous release.

### G3. Header checkpoint

```bash
MURKLE_NETWORK=mainnet node scripts/checkpoint.mjs --network mainnet --height <recent multiple of 2016> --source bitcoind
MURKLE_NETWORK=mainnet node scripts/checkpoint.mjs --network mainnet --height <same height> --source esplora
```

Both outputs must be identical; commit the entry to `src/btc/checkpoints.json`. Evidence: the two outputs,
and the block hash compared by hand with a second explorer.

### G4. Genesis

From the owner's own wallet, on a machine you trust (the CLI wallet file holds plaintext keys):

```bash
export MURKLE_NETWORK=mainnet MURKLE_DATA_DIR=/secure/murkle-owner MURKLE_BTC_SOURCE=bitcoind
node bin/murkle.mjs new owner                  # prints murk1… and the bc1p… fee address; fund the fee address
node bin/murkle.mjs attest genesis owner --dry-run
node bin/murkle.mjs attest genesis owner       # ATTEST kind 1 over manifestSha256
```

After **6 confirmations**, pin it by hand in `src/pins.mainnet.json`:

```json
"genesisTxid": "<txid>",
"activationHeight": <its block height>
```

and add the genesis block as a second base checkpoint (`scripts/checkpoint.mjs --network mainnet --height
<activationHeight> --label "Murkle mainnet genesis (ATTEST <txid prefix>…)"`) to `src/btc/checkpoints.json`.
Evidence: the transaction at its height on two explorers; the server starts without
`MURKLE_ALLOW_PRE_GENESIS`; `GET /api/state` shows `genesis` and no `warning`.

### G5. Mining (optional at launch)

```bash
MURKLE_NETWORK=mainnet node bin/murkle.mjs address-script <platform bc1p… address>   # murkle address-script: prints the scriptPubKey hex
```

Replace the placeholder in `src/params.mjs`:

```js
mainnet: feeRule({ hrp: "bc", platformScript: "<hex from address-script>", platformSats: <owner's amount>n,
  deployerMinSats: 0n, deployerMaxSats: 0n }),
```

then pin a mining height above the genesis height in `src/pins.mainnet.json` (`activations[0].height`), in a
release, at a future height. Without this step mining stays off: the server and the CLI say "mining is not
configured on mainnet", the web app's mining pages say "Mining is not configured on mainnet yet.", and an
indexer with a mining height and the placeholder refuses to start. Evidence: `npm test` with the new rule;
`mineFeeReady()` returns null on mainnet.

### G6. Build and deploy

```bash
MURKLE_NETWORK=mainnet node scripts/facts.mjs --out /tmp/facts.json      # review, then regenerate in place
MURKLE_NETWORK=mainnet npm run web:build
cat web/dist/murkle-build.json        # { "network": "mainnet", "manifestSha256": "...", "genesisTxid": "..." }
```

Install with `deploy/` (systemd units, `deploy/env/murkle.mainnet.env.example`, the reverse proxy with HTTPS,
`MURKLE_CSP_ENFORCE=1`), start the monitor and the backups, and run the restore drill
(`docs/OPERATIONS.md`). The relayer is optional; if it runs, review its settings against current fee levels
(mainnet defaults: fee cap 50 sat/vB, 45,000 sats per transaction, minimum deposit 70,000 sats (its sweep plus two sends at the cap), margin floor
300 sats). Evidence: `GET /api/health?strict=1` answers 200; the monitor prints `ok`; a restored backup passes
`deploy/bin/check-books.mjs`.

### G7. Smoke

- A browser replay of the pool from genesis matches the server's digest (the /verify page).
- Receipts for the genesis ATTEST show the header check level.
- One owner-paid private transfer lands and verifies in another browser.
- If the relayer runs: a small relay deposit is credited and one relayed send lands.
- One real mainnet carrier of each envelope size (471, 503/507, and 511/515 when mining is on) confirms, so
  the OP_RETURN relay policy of today's nodes is known.
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
- [ ] Header verification on, against the owner's own Bitcoin Core (G3, G6).
- [ ] One real mainnet carrier of each size confirmed before the announcement (G7).
- [ ] I-PAY review of the relayer settings at current fee levels: the operator never pays a user's fee, and
      there is no free mode.
- [ ] Backups encrypted, off-site, and a restore drill passed.
- [ ] Monitor alerts tested end to end.
- [ ] CSP enforced (`MURKLE_CSP_ENFORCE=1`).
- [ ] Security contact and repository published (`SECURITY_CONTACT`, `REPO_URL`).
- [ ] Copy review: nothing says mainnet runs before G4, no banned words (docs/CLAIMS.md).
- [ ] External audit done, or the explicit "no external audit yet" disclosure on every surface.
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
  is not checked.
- No external audit yet.

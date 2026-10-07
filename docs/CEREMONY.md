# Murkle trusted-setup ceremony (phase 2)

Status: **tooling ready, ceremony not run.** This resolves audit finding A-8 for Bitcoin mainnet once a public
ceremony has run and its key is pinned (`src/pins.mainnet.json`). Signet keeps its DEV single-party setup by design:
its genesis ATTEST pins that manifest, and a new signet key would break every signet replay.

Contents: why a ceremony · the 1-of-N assumption · what the coordinator can and cannot do · timeline and beacon ·
how to contribute (browser, command line, air-gapped) · what is published · how to verify · operator runbook ·
reference (files, HTTP API, receipt, transcript, manifest) · tests.

## Why phase 2 needs a ceremony

Murkle's transfers are checked with Groth16 proofs. A Groth16 proving key is made in two phases:

- **Phase 1** (powers of tau) is generic. Murkle uses the public Perpetual Powers of Tau transcript
  `powersOfTau28_hez_final_15.ptau` (sha256 `3ef2ecc5…7e7f`), which `scripts/build-circuit.mjs` downloads, checks
  against two pinned hashes and verifies once. Nothing here changes it.
- **Phase 2** is specific to the circuit. It mixes secret random numbers into the key. Whoever knows *all* of that
  randomness (the "toxic waste") can make proofs of false statements, for example spend notes that do not exist.

On signet, phase 2 was made by one party on one machine (`build/manifest.json`: "phase2: dev single-party"), so that
party could forge proofs. That is acceptable for a test network with no value and is disclosed everywhere. For
mainnet, phase 2 is made by many independent people in sequence.

## The 1-of-N assumption, in plain words

Each contributor takes the latest key, multiplies its secret part by a fresh random number of their own, and passes
the result on. To forge proofs, someone would need the random number of **every** contributor. So the final key is
sound if **at least one** contributor generated their randomness honestly and then forgot it (closed the tab,
ended the process). You do not need to trust the other contributors; you only need to believe that one participant,
possibly you, was honest. Whether you also trust the coordinator depends on how you contribute: from the command line,
with a checkout of a commit you reviewed, the coordinator only sees what you upload; in the browser, you run the
JavaScript the coordinator's site serves (see the next section).

What the ceremony does not protect against: a bug in the circuit itself (audit scope), a compromised computer during
your own contribution (malware could read your randomness; then your contribution is worthless, but the others still
count), or every single contributor colluding.

## What the coordinator can and cannot do

The coordinator (`server/ceremony-server.mjs`) runs the queue, stores the keys and publishes the transcript.

It **can**: refuse or delay people (censor), close the queue early, go offline, see contributors' IP addresses (used
only for rate limits; not logged) and their public names.

It **can also**, if it is malicious or compromised, serve a modified ceremony page: the page and its worker (the
entropy, snarkjs) come from the same site, and nothing pins that bundle. A modified page could use randomness the
operator knows, and its uploads would still verify. **Browser contributors therefore trust the JavaScript the site
serves.** The command line (`contribute.mjs`) from an independently checked-out, reviewed commit, or the air-gapped
path, removes that trust; at least some contributors should use it. To compare the page with the source, build the
same commit (`npm ci && npm run web:build`) and compare the sha256 of `web/dist/ceremony.html` and the
`web/dist/assets/` files it loads with the files the site serves.

It **cannot**: forge, replace or remove an accepted contribution without it showing. Every upload is verified with snarkjs
against the r1cs and phase 1 before it is accepted, every intermediate key is published, the final key's contribution
list must equal the transcript in order, and anyone can re-run the whole verification (`scripts/ceremony/verify.mjs`).
Each contributor keeps a receipt with their own contribution hash (computed on their machine, never taken from the
coordinator's answer) and checks that it is in the final transcript. If the coordinator dropped your contribution,
your hash would be missing; if it altered the chain, the verification fails.

The final step is the hash of a Bitcoin block at a height `H` announced before the ceremony starts (the beacon),
which nobody knows until the block is mined. That removes the last contributor's ability to bias the key **only if
the contribution list was fixed publicly before block `H`**. The close height in the transcript, and the chain tip
recorded with each contribution, are the coordinator's own statements. So at the close the coordinator records a
**close commitment** (`transcript.closed.commitment`, a sha256 over the ceremony id and every contribution's index,
name, contribution hash and key hashes), and the operator publishes it at once somewhere independently timestamped
(an OP_RETURN, or public posts that others archive). `verify.mjs --expect-close-commitment <published value>` checks
the final transcript against it. Without a commitment witnessed before `H`, a coordinator that is also the last
contributor could choose that contribution after seeing block `H`. The 1-of-N soundness above does not depend on the
beacon.

## Timeline and beacon

1. **Announce** (at least a week ahead): the ceremony id (for example `murkle-mainnet-1`), the coordinator URL, the
   beacon height `H` (a future Bitcoin mainnet block), and the starting point: `zkeys/0000.zkey` is the deterministic
   `snarkjs zkey new` of the pinned r1cs (`382e5c0a…335e`, 18411 constraints) and ptau. Anyone can recompute it.
2. **Contribution phase**: the queue is open; one contributor at a time.
3. **Close**: the queue closes when the chain tip reaches `H - 6` (the coordinator does this itself when it has a
   chain source; the operator can close earlier with `admin.mjs close`, which leaves more time for the next step).
   The tip at the close is recorded; it must be below `H`. While the coordinator's chain source has not answered
   for 5 polls it gives out no slot and accepts no upload, and its health check fails, so nothing is accepted that
   cannot be placed before `H`.
4. **Publish the close commitment** (`admin.mjs status` prints it) before block `H` exists, somewhere
   independently timestamped. Participants archive it.
5. **Beacon**: once block `H` has 6 confirmations, the operator runs `finalize.mjs`: it reads the 80-byte header at
   `H` (checked: it hashes to the block hash and meets its own proof-of-work target; with two data sources, both must
   serve the same block) and applies `snarkjs zkey beacon` with that block hash, 2^10 iterations. On mainnet the
   header's target must also be within the difficulty bounds from a pinned checkpoint (a difficulty-1 header costs
   about 2^32 hashes, so its own target alone proves little).
6. **Publish** the final key, the verification key, the manifest, every intermediate key and the transcript.
7. **Independent verification**: at least two people outside the project run `verify.mjs` with the announced
   values and the published close commitment, and publish the output.
8. **Pin** the result for mainnet (`finalize.mjs --install`, docs/MAINNET.md step G2).

## How to contribute

Requirements: a computer you trust for the next few minutes, a modern browser (or Node 22+), about 12 MB of download
and upload, and roughly one to three minutes of computation. You choose a public name (1 to 64 printable ASCII
characters). It goes into the key and the transcript; use a handle if you prefer.

### In the browser

Open `https://<coordinator>/ceremony`, enter your name (and, if you like, extra random text), and press *Join the
queue*. Keep the tab open: it polls the coordinator, which is how the coordinator knows you are still there. When your
turn comes, the page downloads the latest key (its sha256 is checked), computes your contribution in a Web Worker with
64 bytes from `crypto.getRandomValues` plus your text (snarkjs adds 64 more random bytes), uploads it and shows the
receipt. The receipt the page saves carries the contribution hash computed in your browser and the sha256 of the
key it uploaded; if the coordinator's answer differs in any of them, or names another key you built on, the page says
not to trust the run. Save the receipt. The randomness is never stored, sent or shown; closing the tab discards it.
Remember that the page itself comes from the coordinator's site (see above).

### From the command line

```
git clone <repository> && cd murkle && npm ci
node scripts/ceremony/contribute.mjs --coordinator https://<coordinator> --name alice --receipt alice-receipt.json
```

The command joins, waits (polling is the heartbeat, keep it running), downloads and checks the key, contributes
(64 bytes from the operating system's random generator, optional `--entropy-text`, plus snarkjs' own 64 bytes),
uploads and prints the receipt. It checks that the coordinator's contribution hash equals the one computed locally.

### Air-gapped

1. Online: `contribute.mjs --coordinator URL --name alice --join-only --download prev.zkey --pass-file pass.txt`
   (waits for your slot, saves the key and your queue pass with mode 0600).
2. Offline machine: `contribute.mjs --in prev.zkey --out next.zkey --name alice` (prints the contribution hash and
   writes it to `next.zkey.contribution-hash`).
3. Online again, before the slot's deadline (15 minutes by default):
   `contribute.mjs --upload next.zkey --coordinator URL --pass-file pass.txt --expect-hash <hash from step 2>`
   (without `--expect-hash` it reads `next.zkey.contribution-hash`, and refuses to upload without either). The
   command fails unless the receipt carries that hash and the sha256 of `next.zkey`.

The queue pass is a bearer credential for your slot only; the pass file is deleted after a successful upload.

### Rules of the queue

- One active slot at a time. The head of the queue gets the slot when it is free.
- The active slot lasts `MURKLE_CEREMONY_SLOT_SECS` (900 s) unless an upload has started by then. Its holder must
  poll once after getting it (every client does) within `MURKLE_CEREMONY_HEARTBEAT_SECS`, or the slot passes on.
- A waiting place that is not polled for `MURKLE_CEREMONY_HEARTBEAT_SECS` (60 s) is dropped.
- An upload may be at most the size of the key it extends plus 64 KiB, must contain exactly one new contribution
  named as you joined, built on the latest accepted key. Three rejected uploads end the slot.
- Joins are limited per address prefix (/24 for IPv4, /48 for IPv6) per hour, one prefix holds at most
  `MURKLE_CEREMONY_MAX_PER_PREFIX` (2) places at once (waiting places plus the slot), the queue has a cap, and joins
  are refused while the coordinator's disk is low. The operator can end a slot (`admin.mjs drop-slot`) and remove a
  prefix's places (`admin.mjs drop-prefix <address>`).

## What is published

- `transcript.json` (live at `/ceremony/api/transcript.json`): ceremony id, circuit and ptau hashes, the initial
  key's hash, the beacon height, every accepted contribution (index, name, contribution hash, sha256 of the key after
  it and of the key it built on, acceptance time), the close record, and after finalisation the beacon block hash and
  header, and the hashes of the final key, verification key and manifest.
- Every key: `/ceremony/files/0000.zkey`, `0001.zkey`, … (immutable).
- `final/transaction.zkey`, `final/verification_key.json`, `final/manifest.json`.

## How to verify

Anyone can run, with the published files:

```
node scripts/ceremony/verify.mjs --transcript transcript.json --zkey final/transaction.zkey \
  [--expect-hash <your contribution hash>] [--zkeys-dir zkeys] [--vkey final/verification_key.json] \
  [--manifest final/manifest.json] [--beacon-source esplora|bitcoind|none] \
  [--expect-ceremony-id <announced id>] [--expect-beacon-height <announced H>] \
  [--expect-close-commitment <the commitment published before block H>]
```

It checks that the r1cs and ptau are the pinned ones; recomputes `0000.zkey`; runs snarkjs `zkey verifyFromInit` on
the final key; compares the key's contribution list with the transcript, in order; checks the beacon contribution was
made with the published block hash (2^10 iterations), that the block header hashes to it and meets its own
proof-of-work target and the difficulty bounds from a pinned checkpoint, and (unless `--beacon-source none`) that a
data source serves that hash at the beacon height (the header check alone does not show the block is on the chain);
the coordinator's record that the queue closed below the beacon height, and the close commitment against the value
you pass; the ceremony id and beacon height against the announcement; that the final key, the exported verification key and the manifest
match the transcript (and `src/pins.mainnet.json` once it pins them); and that your hash is in the transcript. It
prints one line per check and exits 0 only when every check holds. A value it cannot know by itself (the announced
id and height, the published commitment) is a `skip` line naming what to compare by hand when you do not pass it.

For the beacon block, prefer `--beacon-source bitcoind` with your own node (`MURKLE_BITCOIND_URL`,
`MURKLE_BITCOIND_COOKIE`); the default is the public mempool.space API.

## Operator runbook

Hosts and env: a small host is enough (2 vCPU, 4 GB RAM, 50 GB disk). The coordinator is a separate process,
listening on `MURKLE_CEREMONY_HOST:MURKLE_CEREMONY_PORT` (default `127.0.0.1:8790`). The reverse proxy sends
`/ceremony/api/*` and `/ceremony/files/*` to it (body limit 32 MB and a 600 s read timeout on those routes) and
overwrites `X-Forwarded-For`; the indexer serves the page at `/ceremony` (`web/dist/ceremony.html`). Units and proxy
examples: `deploy/` and docs/OPERATIONS.md.

| Variable | Default | Meaning |
|---|---|---|
| `MURKLE_CEREMONY_DIR` | `data/ceremony/<MURKLE_CEREMONY_ID>`, else the only ceremony there | state directory (never `data/signet` or `data/mainnet`) |
| `MURKLE_CEREMONY_R1CS`, `MURKLE_CEREMONY_PTAU` | `build/transaction.r1cs`, `build/ptau/powersOfTau28_hez_final_15.ptau` | must match `ceremony.json` |
| `MURKLE_CEREMONY_SLOT_SECS` | 900 | active slot length |
| `MURKLE_CEREMONY_HEARTBEAT_SECS` | 60 | waiting places must poll within this |
| `MURKLE_CEREMONY_MAX_QUEUE` | 200 | waiting places |
| `MURKLE_CEREMONY_JOIN_PER_HOUR` | 6 | joins per address prefix per hour |
| `MURKLE_CEREMONY_MAX_PER_PREFIX` | 2 | queue places one address prefix holds at once |
| `MURKLE_CEREMONY_VERIFY_SECS` | 600 | verification timeout per upload |
| `MURKLE_CEREMONY_TRUST_PROXY` | off | `1` only behind the proxy that overwrites `X-Forwarded-For` |
| `MURKLE_CEREMONY_CHAIN` | on | `off` disables the automatic close (then close by hand) |
| `MURKLE_BTC_SOURCE`, `MURKLE_ESPLORA`, `MURKLE_BITCOIND_*` | esplora, public mempool.space | chain source for the automatic close; it must serve the beacon network (block 0 is checked) |

Steps:

1. Get the two pinned inputs into `build/`: the r1cs (compile `circuits/transaction.circom` with circom 2.2.2 as
   `scripts/build-circuit.mjs` does, or copy it from a checkout that has it) and the phase-1 ptau (downloaded and
   checked by `scripts/build-circuit.mjs`). `init.mjs` refuses files whose sha256 differs from the pins. Do not run a
   full `npm run circuit:build` on a checkout whose signet genesis is pinned: it would replace the DEV signet key.
2. `node scripts/ceremony/init.mjs --dir data/ceremony/murkle-mainnet-1 --id murkle-mainnet-1 --beacon-height H`
   (refuses a beacon less than 1008 blocks ahead on mainnet; checks the r1cs and ptau pins). Announce `H`, the
   coordinator URL and `0000.zkey`'s sha256.
3. Start the coordinator (`npm run ceremony`, or the systemd unit). Check `GET /ceremony/api/health`.
4. During the ceremony: `node scripts/ceremony/admin.mjs --dir D status | pause | resume | drop-slot | drop-prefix
   <address>`. Back up the directory (it holds public data plus the queue state; losing it means restarting from the
   last published key). Watch `GET /ceremony/api/health`: `chain.stale` means no slots and no uploads until the
   chain source answers again.
5. Close: automatic at `H - 6`, or earlier with `admin.mjs --dir D close` (records the tip; final). Then at once:
   `admin.mjs --dir D status` prints the close commitment; publish it before block `H`.
6. At `H + 6` or later: `node scripts/ceremony/finalize.mjs --dir D --source bitcoind` (with Esplora as the cross
   check) or `--source esplora` (with `--cross-check bitcoind` when a node is available). If the close was recorded
   at or above `H` (the chain source was down until after it), finalize uses the contributions whose recorded tip is
   below the close height: when that is all of them it proceeds; when it is only the first k it refuses unless
   `--drop-late` (the rest are listed in `transcript.final.excluded` and are not in the key).
7. Publish `final/`, `zkeys/` and `transcript.json`; collect independent `verify.mjs` outputs.
8. `finalize.mjs --dir D --install` copies the files to `build/mainnet/` and writes `artifacts.zkey`,
   `artifacts.vkey` and `manifestSha256` into `src/pins.mainnet.json` (only while its `genesisTxid` is null; never
   `src/pins.json`). Continue with docs/MAINNET.md.

Incidents: if the coordinator host may be compromised, pause, take a copy of the directory, run `verify.mjs`-style
checks on the latest key (`verify-one.mjs --init zkeys/0000.zkey --ptau P --zkey zkeys/NNNN.zkey`) and compare its
contribution list with the transcript, then resume, or restart the ceremony from the last verified key under a new id.
A compromised coordinator still cannot forge contributions; it can only censor or stop the ceremony.

## Reference

### State directory

```
ceremony.json     { v, id, protocol, pinned, r1csSha256, constraints, ptau: { name, sha256 }, initialZkeySha256,
                    initialZkeyBytes, beacon: { network, height, closeBeforeBlocks: 6, iterationsExp: 10 },
                    limits: { uploadSlackBytes, nameMaxBytes }, tipAtCreate, createdAt }
transcript.json   public (below)
state.json        { v, phase, queue: [{ passHash, name, joinedAt, lastSeen, pk }], slot, done, expired, closed,
                    prefixSalt, actionsDone }   (pk: an HMAC of the address prefix under prefixSalt, never the address)
control.json      written by admin.mjs: { phase: "open" | "paused" | "closed", tipHeight?, actions?: [{ id, kind, value? }], at }
zkeys/NNNN.zkey   every accepted key; uploads/ holds partial uploads (cleared on start)
final/            transaction.zkey, verification_key.json, manifest.json
```

Only the sha256 of a queue pass is stored; passes are never logged.

### HTTP API (coordinator)

| Method and path | Result |
|---|---|
| `GET /ceremony/api/health` | `{ ok, phase, contributions, waiting, slotActive, verifying, freeDiskBytes, lastError, chain: { configured, stale, tipHeight, lastOkAt, error? } }` (`ok` is false while the disk is low or, before the close, the chain read is stale) |
| `GET /ceremony/api/status` | `{ id, phase, pinned, circuit, ptau, initial, contributions, latest: { index, contributionHash, zkeySha256, bytes, url }, waiting, slot: { active, deadline }, beacon: { network, height, closeBeforeHeight }, closed, heartbeatSecs, slotSecs }` |
| `POST /ceremony/api/join` `{ name }` | 201 `{ pass, position, heartbeatSecs }`; 400 `bad_name`/`bad_json`; 409 `name_taken`; 429 `rate_limited`/`prefix_busy` (`maxPerPrefix`); 503 `queue_full`/`closed`/`paused`/`low_disk` |
| `GET /ceremony/api/turn` (Bearer pass) | `{ state: "waiting", position, heartbeatSecs }` / `{ state: "active", index, base: { index, zkeySha256, bytes, url }, deadline, secondsLeft, maxUploadBytes, uploading }` / `{ state: "done", index }` / `{ state: "expired" }` / `{ state: "unknown" }`; each call is the heartbeat |
| `POST /ceremony/api/contribution` (Bearer pass, `application/octet-stream`, `Content-Length`) | 200 receipt; 422 `{ error: "rejected", reason, attemptsLeft }`; 409 `not_your_turn`/`slot_expired`/`upload_in_progress`; 411 `length_required`; 413 `too_large`; 415 `bad_content_type`; 503 `closed`/`chain_unavailable` |
| `POST /ceremony/api/leave` (Bearer pass) | 200 `{ ok: true }` |
| `GET /ceremony/api/transcript.json` (also `/ceremony/transcript.json`) | the transcript, `no-store` |
| `GET /ceremony/files/NNNN.zkey` | an accepted key, immutable |

`position` counts the people ahead of you, the active contributor included. Errors are `{ error: <code> }`; 401
`unauthorized` without a well-formed pass; 500 `internal` never carries details. No cookies, no CORS headers.

### Receipt

```json
{ "ceremony": "murkle-mainnet-1", "index": 3, "name": "alice", "contributionHash": "<128 hex, blake2b-512 as snarkjs prints it>",
  "zkeySha256": "<64 hex>", "prevZkeySha256": "<64 hex>", "acceptedAt": "2026-10-20T12:00:00.000Z",
  "verifiedWith": "snarkjs 0.7.5 zkey verifyFromInit" }
```

The coordinator computes the contribution hash from the uploaded key (blake2b-512 over the contribution's public key
and transcript, exactly as snarkjs returns it). The clients never take it on trust: the browser page and
`contribute.mjs` compare it, `zkeySha256` (the bytes they uploaded) and `prevZkeySha256` (the key they downloaded,
when known) with their own values, save their own values, and report any difference as a failed run.

### Transcript

```json
{ "version": 1, "ceremony": "murkle-mainnet-1", "protocol": "murkle", "pinned": true,
  "circuit": { "r1csSha256": "382e5c0a…", "constraints": 18411 },
  "ptau": { "name": "powersOfTau28_hez_final_15.ptau", "sha256": "3ef2ecc5…" },
  "initial": { "zkeySha256": "…", "bytes": 12345678 },
  "beacon": { "network": "mainnet", "height": 975000, "closeBeforeHeight": 974994, "iterationsExp": 10 },
  "contributions": [ { "index": 1, "name": "…", "contributionHash": "…", "zkeySha256": "…", "prevZkeySha256": "…", "bytes": 0, "acceptedAt": "…", "tipHeight": 974000 } ],
  "closed": { "at": "…", "tipHeight": 974994, "contributions": 7, "contributionsSha256": "…", "latestZkeySha256": "…", "commitment": "…" },
  "final": { "beaconHeight": 975000, "beaconBlockHash": "…", "beaconHeader": "<80 bytes hex>", "beaconContributionHash": "…",
             "zkeySha256": "…", "vkeySha256": "…", "manifestSha256": "…", "transcriptSha256": "…", "finalizedAt": "…",
             "contributions": 7, "excluded": [] } }
```

`tipHeight` in an entry is the chain tip the coordinator last read when it accepted it (null without a chain source).
The close commitment is `sha256("murkle-ceremony-close/v1\n" + id + "\n" + n + "\n" + contributionsSha256 + "\n" +
latestZkeySha256 + "\n")`, where `contributionsSha256` is the sha256 of the list of `{ index, name, contributionHash,
zkeySha256, prevZkeySha256 }` serialized as below. `final.contributions` is the number of contributions in the final
key; `final.excluded` lists any left out by `finalize.mjs --drop-late` (normally empty or absent).

`transcriptSha256` (also in the manifest) is the sha256 of the transcript serialized with `final` set to `null`
(`JSON.stringify(t, null, 2) + "\n"`), so the manifest and the transcript can name each other.

### Manifest (`final/manifest.json`, installed as `build/mainnet/manifest.json`)

```json
{ "protocol": "murkle", "envelopeVersion": 0, "circom": "2.2.2", "circomlib": "2.0.5", "constraints": 18411,
  "sha256": { "r1cs": "382e5c0a…", "wasm": "7b9f73d4…", "zkey": "<final>", "vkey": "<final>", "ptau": "3ef2ecc5…" },
  "setup": "phase1: PPoT hez_final_15; phase2: public MPC ceremony murkle-mainnet-1, N contributions, beacon Bitcoin block H",
  "ceremony": { "id": "murkle-mainnet-1", "contributions": 7, "transcriptSha256": "…",
                "beacon": { "network": "mainnet", "height": 975000, "blockHash": "…", "iterationsExp": 10 } },
  "network": "mainnet", "gitCommit": "…" }
```

The beacon contribution's snarkjs name is `murkle mainnet beacon: Bitcoin block H` (snarkjs keeps at most 64 bytes of
a name; the block hash itself is stored in the contribution's beacon parameters).

## Tests

`test/ceremony.test.mjs` runs a real ceremony on a 5-constraint circuit (`test/fixtures/ceremony/`) with a power-6
ptau it generates: three contributions over HTTP (CLI online, CLI air-gapped, browser client code in Node), automatic
close, finalisation with the real mainnet block 900000 as the beacon (served by a fake Esplora), `verify.mjs` with
every tampering case, a proof made and verified with the final key, the install into a temporary root, and every
coordinator refusal (bad names, uploads from a waiting place, tampered keys, wrong names, oversize bodies, stale keys,
expired slots and heartbeats, rate limits per prefix, queue cap, pause, close, low disk). With
`MURKLE_CEREMONY_REAL=1` and `build/` present it also recomputes the real circuit's initial key (it must equal
`build/dev/transaction_0.zkey`) and verifies one dry contribution on it in a child process.

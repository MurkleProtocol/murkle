# Murkle

**Private tokens on Bitcoin L1.** Launch and mint tokens in public, then send them privately: zero-knowledge proofs hide the token, the amount and the recipient of each transfer, and which notes it spends. Whether anyone can tell who sent it depends on who pays its fee and how many others use the pool. Every proof is written into a Bitcoin transaction, and any browser can re-check it from raw Bitcoin data.

> **Status: signet test network, test coins with no value.**
> - The phase-2 trusted setup is a single-party **development** setup (audit A-8): whoever ran it could forge proofs until a public ceremony replaces it.
> - The protocol has had an internal review (circomspect, Picus, manual) but **no external audit**.
> - Chain data is read from mempool.space by default, or from your own Bitcoin Core (`MURKLE_BTC_SOURCE=bitcoind`). Block headers are checked from a pinned checkpoint (linkage, proof of work, the difficulty rules, timestamps, most work among what the source serves); a data source can still hide or delay blocks, and the signet block signature is not checked (A-9).
> - **Mainnet is not launched.** The code can run on Bitcoin mainnet (`MURKLE_NETWORK=mainnet`), but no mainnet genesis is pinned and its phase-2 key needs the public ceremony first. The launch checklist: [docs/MAINNET.md](docs/MAINNET.md).
> - Launches and mints are public (token, amount and the paying Bitcoin address); only transfers are private. The anonymity set is small while the pool is early.
> - Mining (tokens issued by proof of work, `docs/design/mining.md`) is built but off: its activation height is not set in this release.

- Protocol specification: [SPEC.md](SPEC.md)
- Internal audit: [audit/REPORT.md](audit/REPORT.md)
- HTTP API of the indexer: [docs/API.md](docs/API.md)
- Design notes: [docs/design/](docs/design/) (index and status of each file: [docs/design/README.md](docs/design/README.md))
- Copy rules (what the project may and may not claim): [docs/CLAIMS.md](docs/CLAIMS.md)
- Mainnet launch checklist: [docs/MAINNET.md](docs/MAINNET.md) · Trusted-setup ceremony: [docs/CEREMONY.md](docs/CEREMONY.md) · Operations: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security reports: [SECURITY.md](SECURITY.md) · License: [below](#license)

## What "verified on-chain" means here
Bitcoin stores and orders Murkle's data; it does **not** run the proofs. The rules are enforced by deterministic replay, the same model as Runes and Ordinals, and anyone can re-run that replay:

- **Proof receipt** (`/tx/<txid>`): your browser fetches the raw transaction from mempool.space, checks its merkle inclusion, decodes the envelope strictly and verifies the Groth16 proof against the pinned verification key. It also shows what a chain observer learns and what stays hidden.
- **Verify the pool** (`/verify`): your browser replays every block since activation with the production indexer, checks every proof and compares the resulting state digest with our server.
  - From a terminal: `node bin/murkle.mjs audit --compare <indexer url>`.
- **Root match**: the wallet rebuilds the note tree from the commitments the indexer serves and checks it against that indexer's root. A match shows the indexer's list and root agree, not that they are Bitcoin's; Verify the Pool checks them against Bitcoin.
- **Genesis anchor**: the circuit and keys are fingerprinted (`src/pins.json`) and attested on Bitcoin by the live genesis ATTEST transaction `4c32443828131fe142d899007c1b8885aef7e62da3034c6f03e4ff7096c6dfad` (signet activation height 324,592); replays start there and refuse anything else.

## Quick start
Requires Node.js 22 or later (`.nvmrc`). The pinned keys can't be rebuilt (the phase-2 zkey holds a random contribution), so a fresh clone downloads them; `npm run artifacts:fetch` checks every file against `src/pins.json` and writes nothing if one differs:
```bash
git clone https://github.com/MurkleProtocol/murkle.git murkle && cd murkle
npm ci
npm run artifacts:fetch -- --from <source>   # see below
npm test                # unit, protocol, relayer, server and UI tests
npm run dev             # indexer API on :8787 + web app on http://localhost:5173
```
- **Where the artifacts come from.** `<source>` is the GitHub release of this repository (`https://github.com/MurkleProtocol/murkle/releases/download/artifacts-41d28d8899f3`) or any running Murkle site or indexer (`https://<site>/artifacts`); a local directory works too. Without `--from`, the script uses `MURKLE_ARTIFACTS_URL`, then the release of `REPO_URL` in `src/params.mjs`. `npm run artifacts:check` checks the files on disk without any network.
- Manual fallback: download `manifest.json`, `verification_key.json`, `transaction.wasm`, `transaction.zkey` and `SHA256SUMS` from the release, run `sha256sum -c SHA256SUMS` (`shasum -a 256 -c` on macOS), and put them at `build/manifest.json`, `build/dev/verification_key.json`, `build/transaction_js/transaction.wasm` and `build/dev/transaction.zkey`.
- Every file is checked against `src/pins.json` again at use: the server and the CLI refuse a different verification key, the server refuses a different manifest, and wallets refuse a different wasm or zkey. The download source doesn't need to be trusted.
- `npm run circuit:build` makes a new zkey. It refuses to run while a genesis is pinned; only a re-genesis may pass `--force`.
- Production build: `npm run web:build`, then `npm run indexer` serves `web/dist` and the API from one port. The build also copies `THIRD_PARTY_NOTICES.md` (and `LICENSE`) into `web/dist`, served as `/THIRD_PARTY_NOTICES.txt` and `/LICENSE.txt`.
- The dev server does not hot-reload: the modules take no hot updates, so a reload on every saved file would also lock an unlocked wallet in every open tab. Reload the page by hand to pick up edits, or set `MURKLE_HMR=1` to get automatic reloads back.
- To use your own indexer from any Murkle site, open `/verify#indexer` there. The choice is kept in that browser and needs no wallet.
- `scripts/facts.mjs` (run by `web:build`) writes `web/src/facts.json` from the build manifest, the pins and the audit findings. The UI shows only these values and live API data.

## Architecture
| Part | Where | Notes |
|---|---|---|
| Circuit | `circuits/` | Circom 2.2.2, Groth16/BN254, 2-in/2-out, depth-32 Poseidon note tree, multi-asset pool; 18,411 constraints |
| Protocol core | `src/` | envelopes (`mrk` magic), keys and `mrk1…` addresses, notes, indexer replay rules, digest v1, raw block/tx parsing |
| Indexer + API | `server/indexer-server.mjs` | syncs signet via mempool.space and serves the API in [docs/API.md](docs/API.md), the SPA, OG meta for `/t/:ticker` and security headers |
| Relay | `server/relayer.mjs`, `server/relay-books.mjs`, `server/retired-relay.mjs`, `src/relay-account.mjs` | optional paid relayer: users prepay a relay balance and each relayed send is charged its fee plus a margin; off unless configured (see below) |
| Web app | `web/` | Vite + framework-free JS: landing, mints, token pages, explorer, proof receipts, verify, security, protocol, wallet |
| CLI | `bin/murkle.mjs` | wallets, deploy/mint/send, `relay account` / `topup` / `credit`, relayed sends (`--relay`), mining (`deploy-pow`, `mine`), `attest genesis`, `audit`, `relayer retire-free`, `relayer evacuate` / `rotate` / `refund-pool` / `sweep-retired` / `status` |

### Relaying: prepaid relay balances
Paying the fee yourself (the built-in key or Unisat) and "Copy envelope" are the default and need no relayer. A relayer is an option on top: it carries your transfer in its own Bitcoin transaction, so your BTC address is not on it, and it is paid from a **relay balance** you top up in advance (`docs/design/relay-balance.md`; interfaces in `docs/design/relay-balance-contract.md`). The operator never pays any part of a user's transaction: there is no free mode, no daily subsidy and no command that adds money to the relayer.

- **Top up.** The wallet derives a relay account from its seed and shows a fresh deposit address for each top-up. Pay it from any signet wallet: a plain payment. Never send real bitcoin to it. After 1 confirmation on signet (3 on mainnet) the wallet asks the relayer to credit it. The minimum deposit is 2,000 sats; a smaller payment is not credited and is not returned. 288 sats of each top-up (at the 5 sat/vB cap) pay for the relayer to spend that coin later. The suggested top-up covers about 10 sends.
- **Send.** Each relayed send is charged its exact carrier fee plus a margin (by default 10%, at least 50 sats; the relayer publishes its settings) from your balance before the carrier is signed. A batch send reserves twice that by default until its batch goes out, and the difference comes back. With too little balance the send is refused before anything is handed over (`balance_low`); you can top up or pay the fee yourself.
- **No forced waits.** Fast goes out at once, Next block at the next block; the Hourly and 10-hour batches wait only because you chose them. Above the relayer's fee cap, Fast and Next block are refused (`fee_high`), never held. A batch item that its balance or the cap cannot pay when it is due becomes `missed`: nothing is charged, the rest of the batch goes out, and the item is never sent later on its own. Retry it in the next batch, at the next block, or pay the fee yourself.
- **Once broadcast, the fee is spent.** The relayer never bumps a carrier. If one is stuck, pay the fee yourself with the same envelope; if the relayer's carrier is also mined, its fee stays spent.
- **What the relayer can see.** It cannot see amounts, tokens or recipients. It knows which balance paid for which relayed transfer, your IP address and the time, and the BTC address you topped up from, because a deposit's inputs are public. So it can link that address to every transfer you relay with this balance; Tor does not prevent this. A send made right after a top-up confirms is easy to link while few people relay; topping up ahead of time, or a batch mode, hides this better. Its files keep balances and credited deposits, and drop the account from a carrier once it is settled.
- **Invariant I-PAY** (audit R-3): the relayer signs only credited deposits and outputs of its own journaled transactions, charges the exact fee before every signature, and stops itself (`halted`) when its books do not add up; self-pay and copy keep working.
- **Without a relayer.** A server not configured for relay balances runs none: `GET /api/relay/info` answers `enabled: false`; `POST /api/relay/submit`, `/account` and `/credit` answer 503 `disabled`; and relay ids of the retired free relayer answer `dropped` ("The free relayer was retired. Pay the fee yourself, or copy the envelope.") from its old `relayer.json`, read and never written.
- **Why the free relayer is gone.** It paid every carrier fee from the operator's BTC. A zero-value transfer is valid and needs no tokens, so anyone with CPU for proofs could make it pay fees without end; budgets, rate limits and proof-of-work only capped the loss per day (audit R-2).
- **The old relayer's coins.** `node bin/murkle.mjs relayer retire-free --to <address> [--dry-run]` sweeps every coin of `data/signet/relayer.key` to an address the operator names, as the operator's own transaction paid from that balance. It matters only to a deployment that ran the v1 free relayer. It refuses while any old carrier may still land or any coin is unconfirmed, and it archives nothing. It takes only `--to`, `--dry-run` and `--fee-rate <sat/vB>`; any other flag (a mistyped `--dryrun`, say) is refused before the key is read. That key is never loaded as relay money again: the paid relayer makes new keys and refuses to start if one equals it.
- **If the relayer's keys may be compromised.** `node bin/murkle.mjs relayer evacuate --to <cold address>` freezes the running relayer at once (no sends or top-ups, queued sends released, nothing charged) and sweeps every coin of its own records to the cold address at a high, bumpable (`--bump`) fee; `relayer rotate` makes new keys with every balance carried over; `relayer refund-pool` refills the new pool from the cold wallet; then the relayer resumes. Balances are never touched and the fees are the operator's cost. Playbook: `docs/OPERATIONS.md` 10.4.1; design: `docs/design/relay-balance.md` §9.
- **After updating a running server.** Run `npm run web:build` before restarting `npm run indexer`: it serves `web/dist`, and an older build shows the old relay copy. `test/english.test.mjs` fails on such a build.
- **Scope, unchanged.** Mints and launches are never relayed: a mint is bound to its payer (A-6), and a relayed launch would let anyone squat tickers at no cost to themselves.

## Networks

`MURKLE_NETWORK` selects the network for the server, the CLI and the web build: `signet` (the default when it is unset or empty) or `mainnet`; any other value refuses to start. The web build fixes it at build time (`MURKLE_NETWORK=mainnet npm run web:build`), and the indexer refuses to serve a web build made for another network.

| | signet (default) | mainnet |
|---|---|---|
| Status | test coins, no value | **not launched**: no genesis pinned |
| Shielded addresses | `mrk1…` | `murk1…` (a wallet refuses the other network's addresses) |
| Bitcoin addresses | `tb1…` | `bc1…` |
| Pins | `src/pins.json` | `src/pins.mainnet.json` |
| Proving key | DEV single-party phase 2 (`build/dev`) | public ceremony output (`build/mainnet`, after the ceremony) |
| Data directory | `data/signet` | `data/mainnet` |
| Tickers | historical rule | strict raw bytes (V2-02) |
| Mining | on from block 325,138 | off: the service-fee address is `TODO_PLATFORM_ADDRESS` until the owner sets it |
| Relayer defaults | fee cap 5 sat/vB, min deposit 2,000 sats | fee cap 50 sat/vB, min deposit 20,000 sats (`server/relayer.mjs` `NETWORK_DEFAULTS`) |

The same recovery phrase gives different keys on each network (network-separated key labels, SPEC.md §2), so signet and mainnet activity are never linked by a shared key. On mainnet the server refuses to start before genesis (`MURKLE_ALLOW_PRE_GENESIS=1` for a staging run), with an unpinned verification key, or without header verification; the CLI runs only `new`, `address`, `address-script`, `attest genesis` and read-only commands before genesis. Everything else: [docs/MAINNET.md](docs/MAINNET.md).

## Configuration (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `MURKLE_NETWORK` | `signet` | `signet` or `mainnet` (server, CLI, web build); anything else refuses to start |
| `MURKLE_INDEXER_PORT` | 8787 | API port (the Vite dev proxy reads it too) |
| `MURKLE_STATE_PATH` | `data/signet/state.json` | indexer server snapshot (`data/<network>/state.json`) |
| `MURKLE_DATA_DIR` | `data/signet` | CLI data directory: its own index snapshot `cli-state.json` (a first run starts from a copy of `state.json` there, if any, and never writes `state.json`) and `wallets/`. Point it elsewhere to test the CLI without touching `data/signet`; keep it outside the checkout, since wallet files hold private keys |
| `MURKLE_ESPLORA` | mempool.space signet | Esplora-compatible chain data source (mempool.space mainnet on mainnet); with the bitcoind source, still used for wallet lookups when set |
| `MURKLE_BTC_SOURCE` | `esplora` | `esplora` or `bitcoind` (your own Bitcoin Core over JSON-RPC; it needs `txindex=1`, so no pruning) |
| `MURKLE_BITCOIND_URL` | `http://127.0.0.1:38332` (signet), `:8332` (mainnet) | Bitcoin Core JSON-RPC endpoint |
| `MURKLE_BITCOIND_COOKIE` | — | path to Core's `.cookie` file (preferred) |
| `MURKLE_BITCOIND_USER`, `MURKLE_BITCOIND_PASSWORD_FILE` | — | rpcauth user and a file that holds its password (never the password itself in the environment) |
| `MURKLE_HEADERS` | `on` | block header verification (SPEC.md §16); `off` is accepted on signet only |
| `MURKLE_HEADERS_PATH` | `data/<network>/headers.json` | the server's verified header chain (the CLI keeps `cli-headers.json` in its data directory) |
| `MURKLE_ALLOW_PRE_GENESIS` | off | mainnet only, staging: start before a genesis is pinned (an unpinned verification key still refuses) |
| `MURKLE_HEALTH_MAX_LAG` | 3 | `GET /api/health`: blocks behind the chain tip before `ok` turns false |
| `MURKLE_CEREMONY_PORT` | 8790 | the ceremony coordinator's port (the Vite dev proxy forwards `/ceremony/api` and `/ceremony/files` to it) |
| `MURKLE_PUBLIC_URL` | — | absolute origin used in OG meta |
| `MURKLE_CSP_ENFORCE` | off | enforce the CSP (it is sent Report-Only by default) |
| `MURKLE_ALLOW_UNPINNED` | off | dev only: start even if `build/manifest.json` does not match `manifestSha256` in `src/pins.json`. It never relaxes the verification key check: a `verification_key.json` that does not match its pin always refuses to start |
| `MURKLE_RELAYER` | 0 | `1` asks for the paid relayer. It starts only together with `MURKLE_RELAY_MODE=balance`, a valid balance configuration and new keys that differ from the retired one; otherwise it logs a refusal, starts no relayer and the indexer keeps running. There is no free mode |
| `MURKLE_RELAY_MODE` | — | must be `balance` for the relayer to start |
| `MURKLE_RELAY_DIR` | `data/signet/relay-balance` | the paid relayer's new `pool.key`, `change.key` and `relayer.json` (version 2), created on first start; never the retired files |
| `MURKLE_RELAY_KEY_PATH`, `MURKLE_RELAY_STATE_PATH` | `data/signet/relayer.*` | the retired free relayer's key (read by `relayer retire-free`, and by the server only to refuse a new key equal to it) and its v1 state (read once to answer old relay ids, never written) |
| `MURKLE_RELAY_URL` | `http://localhost:8787` | CLI: the relayer for `send --relay`, `retry`, `pending`, `relay …` and `mine --pay relay` when no URL is given |
| `MURKLE_POW_THREADS` | available cores − 1, at most 4 | Argon2 worker threads of the indexer server (claim checks) and of `murkle mine` without `--threads` |
| `MURKLE_ARTIFACTS_URL` | — | `npm run artifacts:fetch`: where to download the pinned artifacts (a base URL, a `{name}` template or a local directory) |
| `MURKLE_ARTIFACTS_TAG` | `artifacts-` + 12 hex of `manifestSha256` | `npm run artifacts:fetch`: the release tag under `REPO_URL` |

Keys and relayer state (`MURKLE_DATA_DIR`, `MURKLE_RELAY_DIR`, `MURKLE_RELAY_KEY_PATH`, `MURKLE_RELAY_STATE_PATH`) belong outside the checkout on a real deployment; `.gitignore` also ignores `*.key`, `wallets/`, `relay-balance/` and `.env*` anywhere, as a second safeguard.

**Relay balance settings** (read only by the paid relayer; an invalid value refuses to start it). The defaults below are signet's; mainnet's are in `server/relayer.mjs` `NETWORK_DEFAULTS.mainnet` (fee cap 50 sat/vB, per-transaction cap 45,000 sats, minimum deposit 20,000 sats, margin floor 300 sats, penalties 500 / 200 sats, fan-out 8 coins of 130,000 sats). Same model on both: users prepay, the operator never pays a user's fee, there is no free mode.
- `MURKLE_RELAY_MARGIN_PCT` (10, from 0 to 100) and `MURKLE_RELAY_MARGIN_MIN_SATS` (50): the margin per carrier is the larger of the floor and that share of the fee
- `MURKLE_RELAY_MIN_DEPOSIT_SATS` (2000): smaller deposits are not credited
- `MURKLE_RELAY_DEPOSIT_CONFS` (the network default: 1 on signet and testnet, 3 on mainnet; it can only be raised)
- `MURKLE_RELAY_BATCH_HEADROOM` (2, from 1 to 10): a batch send reserves this many times its cost until release
- `MURKLE_RELAY_SUGGEST_SENDS` (10, from 1 to 100): sends the suggested top-up covers
- `MURKLE_RELAY_INVALID_PROOF_SATS` (50) and `MURKLE_RELAY_INVALID_PER_HOUR` (10): what an invalid proof costs the account that sent it, and how many it may send per hour
- `MURKLE_RELAY_ACCOUNT_PER_HOUR` (120): balance reads and credit calls per IP prefix per hour
- `MURKLE_RELAY_CREDIT_LOOKUPS_PER_MIN` (30, from 1 to 600): explorer lookups that credit calls may cause per minute, all IPs together (the indexer syncs through the same explorer)

**Mining claims** (read only by the paid relayer; mining stays off below its activation height whatever they say):
- `MURKLE_RELAY_MINE_ENABLED` (on): carry mining claims bound to the relayer's change address, paid from relay balances
- `MURKLE_RELAY_MINE_FEE_HEADROOM` (1.25): a claim's carrier pays the next-block fee rate times this, charged to the miner; it is never bumped
- `MURKLE_RELAY_MINE_EST_VSIZE` (684): the size a claim is quoted at
- `MURKLE_RELAY_INVALID_POW_SATS` (20): what refused work costs the account that sent it; it counts toward `MURKLE_RELAY_INVALID_PER_HOUR` like an invalid proof
- `MURKLE_RELAY_POW_QUEUE` (64): Argon2 checks waiting before claims are refused as `busy`
- `MURKLE_RELAY_MEMPOOL_LOOKUPS` (50): mempool transactions looked up per tick to count claims in flight near a supply cap

**Relayer limits** (read only by a relayer):
- `MURKLE_MAX_FEE_RATE` (5 sat/vB) and `MURKLE_MAX_FEE_PER_TX` (3000): above either, sends are refused with `fee_high`, never held
- `MURKLE_MAX_RELAYS_PER_BLOCK`
- `MURKLE_MAX_QUEUE`
- `MURKLE_SAFETY_BLOCKS` (24, from 1 to 94): the relayer sends Next-block, fast and hourly batch transfers by their anchor + 100 minus this
- `MURKLE_MAX_INDEXER_LAG`
- `MURKLE_VERIFY_CONCURRENCY`, `MURKLE_VERIFY_MAX_PER_SEC`
- `MURKLE_FANOUT_TARGET`, `MURKLE_FANOUT_VALUE`, `MURKLE_FANOUT_MIN_CONFIRMED`, `MURKLE_FANOUT_MIN_CARRIERS`
- `MURKLE_MAX_BATCH_PER_EPOCH` (40), `MURKLE_MAX_BATCH10_PER_EPOCH` (120): transfers per hourly / 10-hour batch; 0 turns that length off
- `MURKLE_BATCH_PER_IP` (3): transfers per IP prefix in one batch, for each length
- `MURKLE_BATCH10_SAFETY_BLOCKS` (12, from 1 to 40): the relayer must send a 10-hour batch by its anchor + 100 minus this. The 12-hour batch's `MURKLE_MAX_BATCH12_PER_EPOCH` and `MURKLE_BATCH12_SAFETY_BLOCKS` are no longer read.
- `MURKLE_TRUST_PROXY`
- `MURKLE_BODY_LIMIT`
- `MURKLE_EST_VSIZE`

Defaults are in `server/relayer.mjs`. The free relayer's `MURKLE_DAILY_BUDGET_SATS`, `MURKLE_HOT_FLOOR_SATS`, `MURKLE_POW_BASE_BITS`, `MURKLE_POW_MAX_EXTRA`, `MURKLE_POW_BUDGET_EXTRA`, `MURKLE_ACCEPT_PER_HOUR`, `MURKLE_ACCEPT_PER_DAY` and `MURKLE_REJECT_PER_HOUR` are no longer read.

## Wallet storage (browser)
- `murkle.signet.vault` is the vault: the recovery phrase and the activity history, sealed with XChaCha20-Poly1305 under a key derived from the password with scrypt (N = 65,536, r = 8, p = 1). The key exists only in memory while the wallet is unlocked; auto-lock defaults to 15 minutes.
- `murkle.signet.payer`, `.route`, `.streamer`, `.relayMode` and `.selfMode` hold non-secret preferences. `.route` is `self` (pay the fee yourself, the default), `copy` (copy the envelope) or `relay` (relay from my balance); a saved `relay` reads as `self` while no relayer with relay balances runs. `.relayMode` is the relay timing for payments (Next block or Fast; a batch pick for a payment is not kept). `.selfMode` is the timing for note merges and refreshes (Hourly batch by default; a `batch12` saved by an older version, the retired 12-hour batch, reads as the 10-hour batch).
- Legacy `zkpool.signet.*` keys from before the rename are migrated into a vault once and then deleted.

## CLI
```bash
node bin/murkle.mjs new alice
node bin/murkle.mjs deploy alice --ticker ABC --amount 1000 --cap 100 --price 1000 --treasury tb1…
node bin/murkle.mjs mint alice ABC
node bin/murkle.mjs send alice ABC 250 mrk1…                    # alice's BTC fee address pays
node bin/murkle.mjs relay topup alice                           # a fresh deposit address and the rules
node bin/murkle.mjs relay topup alice --pay 7000 --dry-run      # pay it from the BTC fee key (drop --dry-run to send)
node bin/murkle.mjs relay credit alice                          # once confirmed: credit it to the relay balance
node bin/murkle.mjs relay account alice                         # balance, next deposit address, price per send
node bin/murkle.mjs send alice ABC 250 mrk1… --relay            # relayed, paid from the relay balance
node bin/murkle.mjs pending alice
node bin/murkle.mjs deploy-pow alice --ticker DIG --reward 1000 --max-supply 21000000 --dry-run   # a mined token's launch, not broadcast
node bin/murkle.mjs mine alice DIG --threads 4                   # mine, each claim paid from the separate mining key
node bin/murkle.mjs audit --compare http://localhost:8787
node bin/murkle.mjs attest genesis alice --dry-run
node bin/murkle.mjs relayer retire-free --to tb1… --dry-run      # operator only: sweep the retired relayer's coins
```

`scripts/send-btc.mjs` and `scripts/demo-a6-copy.mjs` are signet development utilities: they read a CLI wallet's BTC key from `$MURKLE_DATA_DIR/wallets/<name>.json` at run time. `send-btc.mjs` takes `--fee-rate <sat/vB>` (default: the explorer's estimate).

Wallet files are written atomically and owner-only (0600 in a 0700 `wallets/` directory on POSIX). Commands that run at the same time on one wallet merge their saves under a `<wallet>.json.lock` file; a lock left behind by a crash expires after 30 s. The CLI keeps its own index snapshot, `cli-state.json`, so it never shares a state file with a running indexer server.

A self-paid send is paid from the wallet's BTC fee address, and Bitcoin shows that address paid for the transfer, permanently. Fund it from a source not linked to your main wallet.

### Relay balance
A relayed send is paid from the wallet's relay balance at the relayer (a server started with `MURKLE_RELAYER=1 MURKLE_RELAY_MODE=balance`). The commands take `--relay <url>`; without it they use `MURKLE_RELAY_URL`, else `http://localhost:8787`. A relayer on another machine needs `https://`; plain `http://` is accepted only for localhost, 127.0.0.0/8, [::1] and .onion addresses. None of them needs a sync.

- `relay account alice` (or `relay balance alice`) prints the account, the available and reserved balance, the next deposit address and the relayer's price per send (fee plus margin at today's rate).
- `relay topup alice` prints deposit address #n, the minimum, the confirmations needed and the suggested amount. Each top-up gets a new address; one that already received a payment is skipped, and payments to older addresses are still credited. `--pay <sats>` pays it from the wallet's BTC fee key with a plain payment (refused below the minimum; `--fee-rate n`; `--dry-run` prints the signed transaction and broadcasts nothing). The relayer then sees that address paid, which links your relay balance to the address your self-paid sends also use; paying from another wallet avoids that.
- `relay credit alice` looks up the wallet's current deposit address (every older one too with `--older`), and every top-up the wallet file keeps as pending (paid with `--pay`, or seen earlier and not credited yet), and asks the relayer to credit each confirmed payment; `relay credit alice <txid:vout> [n]` credits one outpoint. Exit codes: 0 every deposit found is credited (or already was), 1 an error or nothing found, 4 one was refused (below the minimum, another account's address, credited elsewhere), 6 some still wait for confirmations.
- The wallet file keeps `relay.depositIndex`, the address number it shows next; it moves on only after a payment is seen or made.
- The relayer can link the address you top up from to every transfer you relay with this balance; Tor does not prevent this. It cannot see amounts, tokens or recipients. `send --relay` warns when your top-up confirmed recently and few relayed transfers have landed since.

### Relayed sends
`send <w> <ticker> <amount> <mrk1…> --relay [url] [--fast | --batch | --batch10] [--linkable] [--no-wait] [--wait-max <minutes>]` hands the transfer to a relayer, paid from your relay balance. Without a URL it uses `MURKLE_RELAY_URL`, else `http://localhost:8787`. Against a server with no relay balances it says relaying is unavailable there, exits 1 and hands nothing over. Before proving it reads your balance; if the balance does not cover the send (twice the cost for a batch; the difference comes back), it exits 1 with nothing handed over and points to `relay topup`. While too few people have topped up the relay pool, the carrier's input would tie the transfer to your top-up address: the CLI then refuses (exit 1, nothing handed over) unless you add `--linkable`, and a linkable send says so. Before proving it also warns when few notes of other people are in the pool at the proof's anchor, or when the batch would hold only your transfer. For example `send alice ABC 250 mrk1… --relay --batch` or `retry alice --relay --batch`.

| Flag | Relay timing |
|---|---|
| (none) | Next block: goes out when the next block arrives. |
| `--fast` | Goes out at once. |
| `--batch` | Hourly batch: anchored at the last block divisible by 6 (S) and sent with the rest of its batch once block S+6 arrives, so it lands at about S+7. |
| `--batch10` | 10-hour batch: anchored at the last block divisible by 60 (S), sent once block S+60 arrives, lands at about S+61. |

- A batch hides when you pressed send from people watching Bitcoin, not from the relayer: it still sees your IP address and when you submitted. The relayer publishes how many transfers are waiting for each batch, updated once per block; anyone can watch that count, so with few transfers the block you submitted in can be read from it. The CLI prints the count; with few, a batch hides little.
- Hourly and 10-hour transfers with the same anchor land 54 blocks apart, so they are separate crowds, and the 10-hour crowd is thinner.
- By default the relayer has until block S+76 (hourly) or S+88 (10-hour) to send a batch; after that the whole batch expires unsent. A 10-hour batch sent at S+60 has 40 blocks to confirm before its anchor leaves the window at S+100. A scheduled transfer can't be cancelled. Its notes stay reserved until it lands, or until its anchor + 100 (about 17 hours after S) if it never does (wallet invariant W-1).
- Nothing waits for the relayer: above the fee cap any send is refused at once with `fee_high`, and a send its pool coins cannot fund in this block is refused with `pool_low`. Pay the fee yourself, or try again at the next block.
- If your balance (or the fee cap) cannot pay a batch transfer when it is due, it is `missed`: nothing is charged, and it is never sent later on its own. The CLI prints `relay missed` and exits 4; `retry` sends it again.
- A batch spends only notes that existed at S. A send that needs a newer note exits with code 3 and names the block where the next batch starts.
- The CLI records the pending transfer in the wallet file before anything leaves, then waits and reports: block heights until the release, then the carrier, the block it lands in and what was charged. Ctrl+C stops waiting; the relayer keeps the transfer. `--no-wait` returns once it is queued, `--wait-max <minutes>` stops waiting after that long.
- `pending <w> [--relay url]` lists pending transfers with their relay status; a batch is not looked up before its release. `retry <w> [--relay [url]] [--fast | --batch | --batch10]` proves the newest failed, missed or dropped relayed transfer again with the same notes, so it can never pay twice. A transfer saved with the retired 12-hour timing (`batch12`) retries with the 10-hour batch.
- Exit codes: 0 landed (or queued with `--no-wait`), 1 error with nothing handed over (a short balance included), 3 not in this batch, 4 refused, failed or missed, 5 `--wait-max` reached, 130 interrupted.

### Mining
Mined tokens are issued by proof of work instead of a paid mint (`docs/design/mining.md`; binding interfaces in `docs/design/mining-contract.md`). **Mining is active on signet from block 325138** (the `mining` activation height in `src/pins.json`); below it a launch or a claim is an unknown op. Both commands refuse to pay below the activation height; `deploy-pow --dry-run` always builds and prints a launch.

```bash
node bin/murkle.mjs deploy-pow alice --ticker DIG --reward 1000 --max-supply 21000000 --dry-run
node bin/murkle.mjs address alice                              # once mine has run: the mining fee address to fund
node bin/murkle.mjs mine alice DIG --prepare-coins 10          # split the mining key's coins, one per claim
node bin/murkle.mjs mine alice DIG --threads 4 --max-fee-rate 20
node bin/murkle.mjs mine alice DIG --pay relay --max-claims 5  # paid from the relay balance
```

- `deploy-pow <w> --ticker T --reward N --max-supply N` launches a mined token, paid from the BTC fee key like `deploy`. Defaults: a span of 24 blocks (`--span`, 12 to 432); one solution per block (`--per-block`; per-block × span is the number of solutions wanted per span, at least 16, and at most 100 per block); an initial difficulty suggested for a launch hashrate of 2,000 H/s (`--hashrate H`, or set `--difficulty D`); a floor of initial / 16, never below 256 (`--min-difficulty`); no halving (`--halving n`); `--end h`, `--divisibility d` and `--fee-rate r`. The start is one of two choices: `--start now` (the default) opens mining at the launch block itself, whose hash nobody knows before it is mined, so the first claims land in the next block; `--start-after N` opens it N blocks after the next block, counted from the current tip (the start block is fixed when you launch, so a launch that confirms later has a shorter delay). Starting now favours whoever is ready first; a delay gives everyone time to see the terms. The launch must confirm by the `--end` block, and an `--end` before the start is refused, since the launch would be rejected and its fee spent. It prints the terms, the service fee and the disclosures before paying; `--dry-run` prints the signed transaction and broadcasts nothing. Flags are strict, as for `deploy`.
- **Service fee.** Every claim pays a Bitcoin fee and a service fee of 500 sats to the platform address (`MINE_FEE.platformAddress` in `src/params.mjs`, a consensus constant; `deploy-pow` and `mine` print it). There is no deployer fee on signet: `--claim-fee` and `--treasury` are refused with the fee policy's reason, because the indexer rejects a launch with a claim fee. The platform's own claims cost it 500 sats less than everyone else's.
- `mine <w> <TICKER>` hashes Argon2id (4 MiB; hash-wasm after a self-test in every worker, else the reference implementation, about 10 times slower) in worker threads (`--threads N`, at most this machine's logical processors; default the available cores − 1, at most 4, or `MURKLE_POW_THREADS`). Each thread hashes slices of about two seconds, sized from the measured rate, and a worker that times out or crashes is replaced and its slice retried (mining stops only after 10 failed rounds in a row). On each new block and after each solution it builds a new claim draft, so no two claims share a commitment or a nullifier. Notes of the token you already hold are rolled into the reward note, so earnings stay in one or two notes.
- Before paying for a solution it checks it again: the reference Argon2 against the block hash its own Bitcoin backend reports for the reference block (`--esplora url`, default `MURKLE_ESPLORA`; a fast path that disagrees stops mining), the 12-block window (a claim is paid only while the tip is at most 9 blocks past its reference block), the stale bound at the next block, the reward, the solution not claimed yet, and the supply cap counting claims already on the way, each at its own reward (the relayer's count and sum with `--relay`). It also runs the indexer's own checks on the claim. On any failure it prints why and pays nothing.
- `--pay key` (the default) pays each claim from the wallet's **mining key**: a separate key in the wallet file (`mineKey`, created on first use, never the BTC fee key; `address` prints its address once it exists). The carrier spends a coin chosen after the solution is found, pays the next-block fee rate × 1.25 up front (the fee recipient can block a fee bump), signals RBF and sends its change back to the mining key. `--max-fee-rate r` leaves a solution unpaid above r sat/vB. `--prepare-coins n` splits the mining key's balance into n coins that each pay one claim, then exits. Claims paid this way are public: token, reward and the paying address. Anyone can add up what this address mined, and the transfers it pays for later.
- `--pay relay` pays from the relay balance (`--relay url`, else `MURKLE_RELAY_URL`, else `http://localhost:8787`). Each claim is bound to the relayer's change address and charged its Bitcoin fee, the 500-sat service fee and the margin before the relayer signs; the CLI refuses before mining when the balance does not cover a claim. A relayed claim is never paid from your own key, whatever the relayer answers. While the relay pool is thin, claims go only with `--linkable`. The reward goes to a private note, but the relayer sees the token and the reward of every claim it carries for you and can link them to the address you top up from; while few people relay claims, the claims right after a top-up are easy to tie to it. Top up before you start mining.
- **W-M.** Each claim is written to the wallet file's pending list (`kind: "mine"`) before it leaves this machine; its solution and the notes rolled into it stay locked until it lands, its solution is claimed, or block ref + 12 is indexed (`pending` lists it). A claim is never retried, by another route or at all.
- `--max-claims n` stops after n claims are sent; Ctrl+C stops after the current slice of nonces. It prints the hashrate, solutions, claims sent and landed, and the fees spent.
- **Limits.** A single GPU or a server miner can be thousands of times faster than this miner, and anyone can rent many computers. Bitcoin miners choose what goes into blocks and in what order: they can delay a claim until it expires, since a claim must land within 12 blocks of the block it references. Near the cap, a claim that lands after the cap is rejected and its Bitcoin fee and service fee are still spent. Test coins, no value.
- `assets` shows a mined token's issued supply, reward, difficulty and fees. `audit --compare` prints `digest version changes at H (vA -> vB): the other side runs a different release` when two replays first differ at the height where one of them switches digest versions (the mining activation height).

## Reproduce the circuit
The pinned wasm, r1cs and verification key can be checked against the sources in this repository; only the phase-2 contribution inside the zkey cannot be rebuilt. With circom 2.2.2 on the PATH, into a temporary directory (nothing in `build/` is overwritten):
```bash
OUT=$(mktemp -d)
circom circuits/transaction.circom --O2 --r1cs --wasm --sym -o "$OUT"   # circom 2.2.2, from the repository root
sha256sum "$OUT/transaction.r1cs" "$OUT/transaction_js/transaction.wasm"
# Phase 1, the public Powers of Tau file (URL and hashes in scripts/build-circuit.mjs, 37.8 MB):
curl -fLo "$OUT/pot15.ptau" https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
sha256sum "$OUT/pot15.ptau"     # 3ef2ecc5b75d687048cf2d59195119b42fb07c5af639c5f283d84bfa69829e7f
npx snarkjs zkey verify "$OUT/transaction.r1cs" "$OUT/pot15.ptau" build/dev/transaction.zkey   # "ZKey Ok!"
npx snarkjs zkey export verificationkey build/dev/transaction.zkey "$OUT/vkey.json"
sha256sum "$OUT/vkey.json"      # equals artifacts.vkey in src/pins.json
```

| Artifact | sha256 |
|---|---|
| `transaction.r1cs` | `382e5c0a70bf5f327804080f5aee999454a32c1b302017185894b0b363e8335e` |
| `transaction.wasm` | `7b9f73d4c5eccdb982f0a132979f5ceedd0bc08b569b94c022dcf0718ca0fe7d` |
| `verification_key.json` | `893e125967e305cedb1b2d6748ef906a2903779849ef51989ed74969d193a557` |

- `zkey verify` checks that the zkey belongs to this r1cs and to the public phase 1, and lists its one phase-2 contribution ("murkle DEV phase 2, single party, not a ceremony").
- **Phase 1** is the public Perpetual Powers of Tau transcript `powersOfTau28_hez_final_15.ptau`.
  - It is accepted only if its sha256 and the blake2b-512 published in the snarkjs README both match.
  - It is verified once with `snarkjs powersoftau verify`.
- **Phase 2** is a DEV single-party contribution. The resulting `transaction.zkey` cannot be reproduced; it is a published artifact pinned by hash in `src/pins.json`.
- Circom compiles source line numbers into the wasm, so even a comment line added to `circuits/` changes the wasm hash.

## Run an indexer with Docker
```bash
docker build -t murkle-indexer .
docker run -d --name murkle -p 8787:8787 -v murkle-data:/app/data \
  -e MURKLE_ARTIFACTS_URL=<artifact source, see Quick start> murkle-indexer
```
- The container fetches the pinned artifacts on first start (or pass `--build-arg MURKLE_ARTIFACTS_URL=…` to bake them into the image), checks them against `src/pins.json`, then runs `npm run indexer`: the API, the artifacts and the built site on port 8787.
- Chain state lives in the `/app/data` volume; it is rebuilt from the chain if lost.
- The relayer is off (`MURKLE_RELAYER=0`). No keys or wallets are in the image: `.dockerignore` keeps `data/`, `build/`, `*.key` and `.env*` out of the build context.
- Use your own chain source with `-e MURKLE_ESPLORA=<Esplora API URL>`, and compare with any other indexer: `node bin/murkle.mjs audit --compare <indexer url>`.
- For a production host (systemd units, Docker Compose with Bitcoin Core, a reverse proxy with HTTPS, encrypted relayer backups, the monitor), use the deployment kit in [deploy/](deploy/README.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Audit tooling
```bash
npm run audit:picus     # formal under-constraint check (Docker image picus:v0)
```

## Roadmap before a mainnet launch
The full checklist with commands and the go/no-go list: [docs/MAINNET.md](docs/MAINNET.md).
1. External audit of the circuit, indexer and wallet.
2. Public phase-2 ceremony (tooling ready: [docs/CEREMONY.md](docs/CEREMONY.md)).
3. Header-chain checks (A-9): built (SPEC.md §16); open: a single data source can still withhold blocks.
4. Relay balance stage 2: withdrawing what is left of a balance, and spending a balance with blind tokens so the operator cannot link transfers to the top-up address (`docs/design/relay-balance.md` §5).
5. Gift links.
6. Independent indexer operators.

## Source and security
- Source: this repository. `REPO_URL` in `src/params.mjs` is the one place that names it; the site shows the clone command, a Source link and the advisory link once it is set.
- Report vulnerabilities privately: [SECURITY.md](SECURITY.md). The contact is `SECURITY_CONTACT` in `src/params.mjs`, shown on `/security`.

## License
Copyright (C) 2026 Murkle contributors. Licensed under the GNU General Public License v3.0 or later ([LICENSE](LICENSE)), the license the bundled snarkjs and circomlib already impose on the web app, the indexer and the circuit artifacts. Bundled third-party components and their licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

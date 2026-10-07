# Operations

How to install, upgrade, back up, monitor and repair a Murkle node: the indexer and its API (one
process, which also runs the paid relayer when it is switched on) and, during a trusted-setup
ceremony, the ceremony coordinator. The files referenced here are in `deploy/` (`deploy/README.md`
lists them). The launch sequence and the go/no-go list are in `docs/MAINNET.md`; the ceremony is in
`docs/CEREMONY.md`; the design and the build contract are in `docs/design/mainnet-readiness.md`.

Mainnet has not launched. A mainnet build refuses to start until the mainnet pins hold the
ceremony's verification key and a genesis (`docs/MAINNET.md`). Signet stays the default network.

Contents

1. What runs where
2. Requirements
3. Install (host, systemd)
4. Install (Docker Compose)
5. Upgrade and rollback
6. Restarts: what survives them
7. Backups and the restore drill
8. Monitoring and alerts
9. Logs
10. Incident playbook

---

## 1. What runs where

| Path | What | Owner and mode |
|---|---|---|
| `/opt/murkle/releases/<tag>/` | one built release (code, `node_modules`, `web/dist`, `build/` artifacts) | root, read-only |
| `/opt/murkle/current` | symlink to the running release | root |
| `/etc/murkle/murkle.env` | settings (from `deploy/env/murkle.<network>.env.example`) | root:murkle 0640 |
| `/etc/murkle/ceremony.env` | coordinator settings (`deploy/env/ceremony.env.example`) | root:murkle 0640 |
| `/etc/murkle/secrets/` | secret files only (an RPC password file, if not using the cookie) | root:murkle 0750, files 0640 |
| `/var/lib/murkle/<network>/` | `state.json`, `headers.json`, `archive/`, `relay-balance/` (relayer keys and books) | murkle 0700 |
| `/var/lib/murkle/ceremony/<id>/` | the coordinator's queue, transcript and accepted keys | murkle |
| `/var/backups/murkle/` | encrypted backups (`*.mbk`), to be copied off the server | murkle 0700 |

Units (`deploy/systemd/`): `murkle-indexer.service` (plus the optional relayer drop-in),
`murkle-ceremony.service`, `murkle-monitor.service` with `murkle-monitor.timer` (every minute),
`murkle-backup.service` with `murkle-backup.timer` (hourly) and the template `murkle-backup@.path`
(on every change of the relayer's books; the instance is the network, `murkle-backup@<network>.path`). Every unit runs as the `murkle` user with `NoNewPrivileges`,
`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, write access to `/var/lib/murkle` only
(backups: `/var/backups/murkle` only), `Restart=on-failure` and a memory cap.

The relayer is optional. It runs inside the indexer process when the drop-in
`murkle-indexer.service.d/relayer.conf` sets `MURKLE_RELAYER=1` and `MURKLE_RELAY_MODE=balance`.
Users prepay their relay balances; the operator never pays a user's fee (I-PAY), and there is no
free mode. Its keys and books hold users' prepaid deposits, which is why backups run before it is
switched on.

## 2. Requirements

| | signet | mainnet |
|---|---|---|
| Indexer host | 2 vCPU, 4 GB RAM, 20 GB disk (with the Esplora source) | 4+ vCPU, 16 GB RAM, 1.5 TB+ SSD (Bitcoin Core unpruned with `txindex=1`) |
| Chain data | mempool.space (default) or your own Bitcoin Core | your own Bitcoin Core 30 or later (`MURKLE_BTC_SOURCE=bitcoind`) |
| Ceremony coordinator | small host, 50 GB disk | same |
| Node.js | 22 LTS | 22 LTS |

Bitcoin Core must keep `txindex=1` (the indexer looks up prevouts of arbitrary transactions), so it
cannot be pruned. Bitcoin Core 30's default `datacarriersize` relays the 471-515 byte OP_RETURN
carriers Murkle uses; older or filtering nodes do not.

## 3. Install (host, systemd)

The commands assume Debian or Ubuntu with systemd and are run as root unless a line says otherwise.
Replace `signet` with `mainnet` where the network appears.

### 3.1 Node.js 22 from a checked tarball

Download `node-v22.<x>.<y>-linux-x64.tar.xz` and `SHASUMS256.txt` plus `SHASUMS256.txt.sig` from
nodejs.org, verify the signature with the Node.js release keys you trust, then the tarball:

```sh
gpg --verify SHASUMS256.txt.sig SHASUMS256.txt
grep " node-v22.*-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c -
tar -xJf node-v22.*-linux-x64.tar.xz -C /usr/local --strip-components=1
node --version
```

The units call `/usr/bin/node`; link it (`ln -s /usr/local/bin/node /usr/bin/node`) or edit the units.

### 3.2 User and directories

```sh
useradd --system --home-dir /var/lib/murkle --shell /usr/sbin/nologin murkle
install -d -o root -g root -m 0755 /opt/murkle /opt/murkle/releases
install -d -o root -g murkle -m 0750 /etc/murkle /etc/murkle/secrets
install -d -o murkle -g murkle -m 0700 /var/lib/murkle /var/lib/murkle/signet /var/backups/murkle
```

### 3.3 Build a release

Build as an unprivileged user in a scratch directory, from the release tag. The web build needs
the development dependencies; they are pruned afterwards. `MURKLE_NETWORK` is fixed into the web
app at build time, and the server refuses a `web/dist` built for another network.

```sh
# as an unprivileged build user
git clone --branch <tag> <repository> murkle-<tag> && cd murkle-<tag>
npm ci
node scripts/fetch-artifacts.mjs --from https://<a Murkle site>/artifacts   # every file checked against the pins
MURKLE_NETWORK=signet npm run web:build
npm prune --omit=dev
npm test                    # optional here; required before a release is tagged
```

Then, as root, install it read-only and point `current` at it:

```sh
cp -a murkle-<tag> /opt/murkle/releases/<tag>
chown -R root:root /opt/murkle/releases/<tag>
chmod -R go-w /opt/murkle/releases/<tag>
ln -sfn /opt/murkle/releases/<tag> /opt/murkle/current
cd /opt/murkle/current && MURKLE_NETWORK=signet node scripts/fetch-artifacts.mjs --check
```

### 3.4 Bitcoin Core (optional on signet, required on mainnet)

Install Bitcoin Core 30 or later from bitcoincore.org (verify `SHA256SUMS` and its signatures),
use `deploy/bitcoin/bitcoin.conf.example` (`txindex=1`, no prune, no wallet, RPC on localhost,
cookie authentication with `rpccookieperms=group`), and let the `murkle` user read the cookie:

```sh
usermod -aG bitcoin murkle
# murkle-indexer.service.d/bitcoind.conf
#   [Unit]
#   Wants=bitcoind.service
#   After=bitcoind.service
#   [Service]
#   SupplementaryGroups=bitcoin
```

The indexer refuses a node on another chain (`getblockchaininfo.chain`) or without a synced
`txindex`, and indexes only up to the node's `blocks` during its initial block download.

### 3.5 Settings

```sh
cp /opt/murkle/current/deploy/env/murkle.signet.env.example /etc/murkle/murkle.env
chown root:murkle /etc/murkle/murkle.env && chmod 0640 /etc/murkle/murkle.env
editor /etc/murkle/murkle.env
```

The file holds no secrets: a password, when the node is not on cookie authentication, goes in a file
under `/etc/murkle/secrets/` and only its path in `MURKLE_BITCOIND_PASSWORD_FILE`. Mainnet sets
`MURKLE_CSP_ENFORCE=1` (go/no-go) and cannot turn header verification off.

### 3.6 Backup key (before the relayer)

On an offline machine with a copy of the release:

```sh
node deploy/bin/backup.mjs keygen --out murkle-backup.key
```

It prints `murkle-backup-pub:<...>`. Put that public key in `MURKLE_BACKUP_RECIPIENT`. Keep
`murkle-backup.key` offline, in two places; without it no backup can be restored, and it never goes
on the server.

### 3.7 Units

```sh
cp /opt/murkle/current/deploy/systemd/*.service /opt/murkle/current/deploy/systemd/*.timer \
   /opt/murkle/current/deploy/systemd/*.path /etc/systemd/system/
cp /opt/murkle/current/deploy/journald/murkle.conf /etc/systemd/journald.conf.d/murkle.conf
cp /opt/murkle/current/deploy/logrotate/murkle /etc/logrotate.d/murkle
NET=mainnet                                          # or signet: the same as MURKLE_NETWORK
systemctl daemon-reload
systemctl restart systemd-journald
systemctl enable --now murkle-indexer.service murkle-monitor.timer murkle-backup.timer "murkle-backup@$NET.path"
```

The monitor also checks the newest backup in `MURKLE_BACKUP_DIR` (older than 3 hours, or none:
a warning, critical while the relayer runs).

The paid relayer, only after the backup timer has produced a backup you have verified (7.3):

```sh
install -d /etc/systemd/system/murkle-indexer.service.d
cp /opt/murkle/current/deploy/systemd/murkle-indexer.service.d/relayer.conf.example \
   /etc/systemd/system/murkle-indexer.service.d/relayer.conf
editor /etc/systemd/system/murkle-indexer.service.d/relayer.conf   # the network in MURKLE_RELAY_DIR
install -d /etc/systemd/system/murkle-backup.service.d
cp /opt/murkle/current/deploy/systemd/murkle-backup.service.d/relayer.conf.example \
   /etc/systemd/system/murkle-backup.service.d/relayer.conf
systemctl daemon-reload && systemctl restart murkle-indexer
systemctl start murkle-backup.service   # must succeed: it now requires the relayer's keys
```

The relayer refuses a `MURKLE_RELAY_DIR` that names the other network (a `signet` or `mainnet`
path segment). With the backup drop-in, a backup that lacks `relay-balance/pool.key`, `change.key`
or `relayer.json` in `/var/lib/murkle/<network>` fails instead of succeeding without the keys. On
mainnet the relayer does not start before genesis (deposits could neither pay for a transfer nor
be withdrawn); `MURKLE_ALLOW_PRE_GENESIS_RELAYER=1` overrides that for a deliberate staging test
with the operator's own coins only.

Do not set `MURKLE_RELAYER`, `MURKLE_RELAY_MODE` or `MURKLE_RELAY_DIR` in `murkle.env`: values from an
`EnvironmentFile=` override the drop-in's `Environment=` lines.

### 3.8 Reverse proxy

Caddy (`deploy/caddy/Caddyfile`, automatic certificates; give the Caddy service `SITE_DOMAIN` and
`ACME_EMAIL` with `systemctl edit caddy`, `[Service]` `Environment=` lines) or nginx with certbot
(`deploy/nginx/murkle.conf`). Both terminate TLS, send HSTS, overwrite `X-Forwarded-For` with the
client address (the relayer and the coordinator rate-limit by it), keep no access log, and route
`/ceremony/api/*`, `/ceremony/files/*` and `/ceremony/transcript.json` to the coordinator with a
32 MB body limit and 600 s timeouts; everything else goes to the indexer. Set
`MURKLE_TRUST_PROXY=1` (and `MURKLE_CEREMONY_TRUST_PROXY=1`) only behind the proxy.

The server sends its own Content-Security-Policy: enforced by default on mainnet (a mainnet server
running Report-Only, `MURKLE_CSP_ENFORCE=0`, logs a warning at start), Report-Only by default on
signet, where `MURKLE_CSP_ENFORCE=1` makes it enforcing.

### 3.9 First start

```sh
journalctl -u murkle-indexer -f            # genesis, chain source, header base checkpoint, sync
curl -s http://127.0.0.1:8787/api/health   # ok, lagBlocks, headers, relayer, artifacts
sudo -u murkle node /opt/murkle/current/deploy/bin/monitor.mjs; echo "exit $?"
systemctl start murkle-backup.service && ls -l /var/backups/murkle
```

## 4. Install (Docker Compose)

`deploy/docker/docker-compose.yml` runs Bitcoin Core (built from the official tarball by
`deploy/docker/bitcoind.Dockerfile`; `BITCOIN_VERSION` and `BITCOIN_SHA256` are required), the
indexer from the repository's `Dockerfile` (built for `MURKLE_NETWORK`, reading the node's cookie
from the shared volume) and Caddy. Profiles: `ceremony` (the coordinator) and `electrs` (an
Esplora-compatible API on the same node, optional).

```sh
cp deploy/docker/compose.env.example deploy/docker/compose.env   # edit: network, chain, Bitcoin Core release and hash, domain
docker compose -f deploy/docker/docker-compose.yml --env-file deploy/docker/compose.env up -d --build
docker compose -f deploy/docker/docker-compose.yml --env-file deploy/docker/compose.env ps
```

The containers log through the json-file driver with size limits. The image's `HEALTHCHECK` is
liveness only: a halted relayer or a lagging indexer never restarts the container. Run
`deploy/bin/monitor.mjs` from the host (cron or a systemd timer) against the published port or the
proxy, and back up the `murkle-data` volume with `deploy/bin/backup.mjs --data <volume path>/<network>`.

## 5. Upgrade and rollback

1. Read the release notes: a new activation height, a new state format or new settings.
2. Back up now: `systemctl start murkle-backup.service`, then check the new file with
   `backup.mjs verify` on the offline machine (7.3) when the relayer is on.
3. Build the new release into `/opt/murkle/releases/<new tag>` (3.3) and check its artifacts:
   `MURKLE_NETWORK=<network> node scripts/fetch-artifacts.mjs --check`.
4. Switch and restart:

   ```sh
   ln -sfn /opt/murkle/releases/<new tag> /opt/murkle/current
   systemctl restart murkle-indexer
   curl -s http://127.0.0.1:8787/api/health
   ```

5. Watch the journal until the indexer is at the tip and `/api/health` answers `ok: true`.

Rollback: point the symlink back at the old release and restart. When the new release pinned an
activation height and had already applied blocks at or above it, the old release must not keep
that state. Current releases handle both directions at start (`loadIndexer` rewinds a state written
under another activation table through its undo journal, when the journal reaches back far enough,
and syncs those blocks again). For an older release without that logic, or to pick the height
yourself, roll the state back before starting it:

```sh
systemctl stop murkle-indexer
sudo -u murkle node /opt/murkle/current/deploy/bin/state-rollback.mjs \
  --state /var/lib/murkle/<network>/state.json --to <activation height - 1> --dry-run
sudo -u murkle node /opt/murkle/current/deploy/bin/state-rollback.mjs \
  --state /var/lib/murkle/<network>/state.json --to <activation height - 1>
systemctl start murkle-indexer
```

`state-rollback.mjs` writes a new state file and moves the old one to `archive/` (it never deletes
one). It refuses a height deeper than the undo journal (144 blocks); then archive the state file and
let the indexer resync from the genesis block. `headers.json` needs no change. A relayer state of a
newer format is refused by an older relayer ("is a version N relayer state"): keep the relayer off
(remove the drop-in) until the newer release runs again.

## 6. Restarts: what survives them

- **Indexer.** The state is saved after every block (temp file plus rename), so a stop at any point
  loses at most the block being applied, which is applied again. A state file from another genesis
  or start height is archived (never deleted) and the indexer resyncs. The header chain is saved
  after the state; a missing or damaged `headers.json` is rebuilt from the pinned checkpoint.
- **Relayer.** It journals every transaction before broadcasting it, writes its state durably
  (fsync, rename) and on start reconciles its coins and items with the chain before it signs
  anything new. Balances, reservations and charges survive restarts. A carrier is re-sent with the
  same bytes and never re-signed.
- **Coordinator.** Its queue and slot are in its state directory; a restart keeps accepted
  contributions and the transcript. An upload in progress is lost; the contributor uploads again
  within the slot or rejoins (`docs/CEREMONY.md`).
- `systemctl restart` is safe at any time. Never run two indexers (or two relayers) on the same data
  directory.

## 7. Backups and the restore drill

### 7.1 What is backed up

`deploy/bin/backup.mjs backup` reads, from `/var/lib/murkle/<network>/`: `relay-balance/pool.key`,
`relay-balance/change.key`, `relay-balance/relayer.json`, `state.json` and `headers.json` (missing
files are skipped and listed). It encrypts them to the public key in `MURKLE_BACKUP_RECIPIENT`
(X25519, HKDF-SHA256, XChaCha20-Poly1305) into `/var/backups/murkle/murkle-backup-<network>-<time>.mbk`
(mode 0600), keeps the newest 48 plus the newest of each of the last 14 days, and deletes the rest.
A node upgraded from the retired free relayer adds its old files with
`--include relayer.key --include relayer.json` (in the unit's `ExecStart=`). After a key rotation
(10.4.1) the backup also takes `relay-balance/account-tags.key` and every file under
`relay-balance/retired/` by itself: without `account-tags.key` the books cannot be read.

The relayer's keys and books are the part that cannot be rebuilt: they hold users' prepaid
deposits. The indexer state and the header chain can be rebuilt from the chain; they are in the
backup to shorten a restore.

### 7.2 Schedule and off-site copies

The timer runs hourly; the path unit runs a backup when `relayer.json` changes, at most once per 5
minutes (`--min-interval 300`). Copy `/var/backups/murkle` off the server at least daily (rsync to
another host, object storage); the files are encrypted, the key is not on the server. Check that the
copies arrive (the newest file's age is part of the monthly review).

### 7.3 Restore drill (quarterly, and before switching the relayer on)

On the offline machine that holds the backup key, with a copy of the newest backup:

```sh
node deploy/bin/backup.mjs verify --key murkle-backup.key --in murkle-backup-<network>-<time>.mbk
node deploy/bin/backup.mjs restore --key murkle-backup.key --in murkle-backup-<network>-<time>.mbk --to ./drill
node deploy/bin/check-books.mjs --state ./drill/relay-balance/relayer.json
node deploy/bin/state-rollback.mjs --state ./drill/state.json --to <its height - 1> --dry-run
```

`verify` decrypts and checks every file's sha256 without writing. `check-books` restores the books
as the relayer does and checks I2 (credited - fees - serviceOut - balances - reserved = margin >= 0,
and the recorded pool coins cover balances, reservations and margin) and that the key files belong
to the state. The `--dry-run` rollback proves the state loads (its root and digest are recomputed).
Record the date, the backup's time and the outputs. Then delete `./drill` with `shred -u` on its key
files: it holds the relayer's keys.

Never start a relayer from a drill copy or from any second copy of the production keys: two relayers
with the same keys would credit and spend the same coins twice.

### 7.4 Restore after a loss

```sh
systemctl stop murkle-indexer
node deploy/bin/backup.mjs restore --key murkle-backup.key --in <newest>.mbk --to /var/lib/murkle/<network> --force
chown -R murkle:murkle /var/lib/murkle/<network> && chmod -R go-rwx /var/lib/murkle/<network>
```

Restore on the offline machine and copy the result over, or bring the key to the server for the
restore only and remove it afterwards. Start with the relayer **off** (remove the drop-in), let the
indexer reach the tip, run `check-books.mjs` on the restored `relayer.json` and compare its coins
with the chain (the pool key's and change key's addresses on a block explorer or your node). A
backup older than the relayer's last change is a state the relayer has not seen: what happened after
it is on the chain, the relayer reconciles its coins and items on start, and its I2 check halts it
if the books and the coins disagree. Turn the relayer on only when `check-books.mjs` passes and the
coins match the chain.

## 8. Monitoring and alerts

`deploy/bin/monitor.mjs` runs every minute. It reads `GET /api/health?strict=1` (falling back to
`/api/state` and `/api/relay/info` on an older indexer), the coordinator's `/ceremony/api/health`
when `MURKLE_MONITOR_CEREMONY_URL` is set, and the free space of `MURKLE_MONITOR_DATA_DIR`. It prints
one JSON line, exits 0 (ok), 1 (warning) or 2 (critical), and with `MURKLE_MONITOR_WEBHOOK` POSTs
that line when the alerts change.

| Code | Level | Meaning | First action |
|---|---|---|---|
| `indexer_down` | critical | no answer from the indexer | `systemctl status murkle-indexer`, `journalctl -u murkle-indexer` |
| `stale` | critical | no completed sync for 10 minutes | the chain source: node down, mempool.space unreachable; `lastError` |
| `never_synced` | warning | started, no sync finished yet | normal for a minute after a start; else as `stale` |
| `lag` | warning | more than `MURKLE_MONITOR_MAX_LAG` (3) blocks behind | a slow source or a slow block (mining claims); watch it |
| `sync_error` | warning | the last tick failed (`lastError`) | read the message; a retryable source error clears itself |
| `header_error` | critical (warning when retryable) | a header failed verification (linkage, proof of work, difficulty, checkpoint) | the source served invalid data: 10.3 |
| `less_work` | critical | the source served a branch with less work; the indexer kept its chain | 10.3 |
| `headers_off` | warning | header verification is off (signet only) | turn it on unless this is deliberate |
| `relayer_halted` | critical | the relayer's books check (I2) failed, or an operator's hold (evacuation, rotation, maintenance) is in place; it signs nothing new | 10.1; a hold: 10.4.1 |
| `artifacts` | critical | the artifacts on disk do not match the pins | 10.6 |
| `health_not_ok` | warning | `/api/health` says `ok: false` for a reason not listed above | read `/api/health` |
| `disk_low` | warning, critical below a quarter | free space under `MURKLE_MONITOR_MIN_FREE_GB` (20) | 10.7 |
| `disk_unknown` | warning | the data directory cannot be read | the path in `MURKLE_MONITOR_DATA_DIR` |
| `ceremony_down`, `ceremony_not_ok` | warning | the coordinator does not answer, or reports a problem | `journalctl -u murkle-ceremony` |
| `ceremony_chain_stale` | critical | the coordinator's chain source has not answered for 5 polls while the queue is open: no slots, no uploads | fix the source (cookie permissions, rate limits) before the beacon height; docs/CEREMONY.md |
| `no_backup`, `backup_old`, `backup_unknown` | critical while the relayer runs, else warning | no backup in `MURKLE_BACKUP_DIR`, the newest is older than `MURKLE_MONITOR_MAX_BACKUP_AGE_HOURS` (3), or the directory cannot be read | `systemctl status murkle-backup.service`; a failed run with the relayer on means its keys were not where the backup looks (`MURKLE_RELAY_DIR` must be `/var/lib/murkle/<network>/relay-balance`) |

Test the alert path at least once before launch: stop the indexer (`systemctl stop murkle-indexer`),
wait for the webhook, start it again and wait for the recovery post.

## 9. Logs

The services log to the journal (`journalctl -u murkle-indexer`); `deploy/journald/murkle.conf`
bounds it (2 GB, 30 days). The indexer and the relayer do not log IP addresses, keys or relay
account secrets. The proxies keep no access log; `deploy/logrotate/murkle` rotates their error logs
and anything under `/var/log/murkle`. Docker Compose services use the json-file driver with 5 files
of 20 MB each.

## 10. Incident playbook

Write down what you see and do, with times, as you go. Copy the relevant journal lines before any
restart.

### 10.1 Relayer halt (I2 failed)

The relayer stopped itself because its books do not add up, or its coins would not cover balances,
reservations and margin. It signs nothing new; users can still pay their own fees or copy the
envelope, and their balances are kept.

1. Do not restart in a loop: a restart re-runs the same check.
2. Read the halt problems: `curl -s 127.0.0.1:8787/api/health` (`relayer.problems`) and
   `journalctl -u murkle-indexer | grep "relayer halted"`.
3. Run `check-books.mjs` on a copy of `relayer.json` and compare the relayer's coins with the chain
   (the change key's and the pool key's addresses).
4. If it cannot be resolved quickly, switch the relayer off (remove the drop-in, daemon-reload,
   restart): the indexer keeps serving and wallets self-pay.
5. Never move pool coins by hand: the books are the record of what each user is owed, and a manual
   transaction makes them disagree with the chain. The one exception is a suspected key compromise,
   and it goes through the tools of 10.4.1, which keep the books.
6. A halt with code `relayer_evacuating`, `pool_unfunded` or `maintenance` is an operator's hold
   (10.4.1), not a books problem: follow that playbook.

### 10.2 Reorg

Reorgs up to 144 blocks deep are handled automatically (the undo journal). A deeper one stops the
sync with "reorg deeper than undo log; full resync needed": stop the indexer, move `state.json` into
`archive/`, start it again; it resyncs from the genesis block. The relayer reconciles its own items
with the chain (a deposit that left the chain is reversed; a carrier that left it is re-sent with
the same bytes).

### 10.3 Header errors and `less-work`

A `less-work` error means the data source served a branch with less cumulative work than the one
the indexer holds. The indexer did not roll back and keeps serving its chain. Switch the source to
your own Bitcoin Core (`MURKLE_BTC_SOURCE=bitcoind`) and keep the indexer where it is; do not delete
`headers.json` to make the error go away. Other header errors (broken linkage, proof of work,
difficulty, a checkpoint mismatch) mean the source served data that is not a valid Bitcoin chain:
the same response. `time-too-new` is retryable and clears on its own.

What the header check does not cover: a single source can still hide or delay blocks, and on signet
the block signature (BIP325) is not checked, so signet proof of work is nearly free to fake.

### 10.4 Key compromise

- **Relayer keys** (`relay-balance/pool.key`, `change.key`): they control users' prepaid deposits.
  Follow 10.4.1 at once. Every user's balance stays owed in full through all of it: the books are
  carried over unchanged, and the evacuation's fees are the operator's cost, never a user's.
- **Platform fee address** (mining service fee): it only receives fees. Changing it is a consensus
  change: a new fee rule with its own activation height, announced in advance.
- **Backup key**: generate a new key pair offline, set the new `MURKLE_BACKUP_RECIPIENT`, take a new
  backup, then delete the old backups everywhere (they are readable with the old key).
- **TLS certificate or domain**: revoke and reissue, rotate the server's credentials, and remind
  users that the artifacts and the verification key are pinned in the code, so a site that serves
  other artifacts is refused by the wallet; users who doubt the site can verify with their own
  indexer (`/verify`).
- **Bitcoin Core RPC credentials**: restart the node to rotate the cookie (or change `rpcauth`).

#### 10.4.1 Relayer keys: evacuate, rotate, refill, resume

Suspect a compromise when the relayer's keys may have left the server (a server or backup breach,
a leaked `relay-balance/` copy, an unknown transaction spending the pool key's or the change key's
coins). Anyone holding the keys can spend every coin the relayer holds, so speed matters more than
certainty. Run the commands as the service user in the release directory, with the same
`MURKLE_NETWORK` and `MURKLE_RELAY_DIR` as the service (`/etc/murkle/murkle.env`); prefix them with
`MURKLE_ESPLORA` or `MURKLE_BTC_SOURCE` as the service has them. Design: `docs/design/relay-balance.md` §9.

1. **Have a cold address ready.** One whose key never was on this server (a hardware wallet, or a
   key made offline). Keep its key file off the server; `refund-pool --from` needs it later on the
   machine where you run that step.
2. **Evacuate.**

   ```sh
   murkle relayer evacuate --to <cold address> --dry-run   # optional: the plan, nothing written or sent
   murkle relayer evacuate --to <cold address>
   ```

   It writes `HOLD` into the relay directory: the running relayer sees it within a second, refuses
   every new send and credit (503 `relayer_evacuating`), releases its queued items (status `missed`,
   reservation returned, nothing charged), saves once, writes `HOLD.ack` and never writes its files
   again until it is restarted without `HOLD` (a relayer started while `HOLD` is there starts frozen;
   while `HOLD` is in place a relayer that has not frozen yet never overwrites what a tool wrote).
   Carriers already broadcast keep their status. A carrier that was signed but not known to be sent
   is sent again first (it is the user's paid transaction: never refunded while it can still land);
   one whose broadcast answer was lost stays charged until its anchor window closes, and `rotate`
   waits for it (it names the block); past the window `evacuate` sweeps its coin. Then every coin the relayer's own records say it
   controls (credited deposits not merged yet, change coins of its own transactions) is swept to
   the cold address, in as few transactions as the standard size and the mempool's 25-ancestor
   limit allow, at twice the next-block rate (or `--fee-rate`), every input signalling RBF. Coins
   anyone else sent to its addresses are never in those records and are not touched. The fees are
   paid from the margin account; what it cannot cover is recorded as the operator's liability
   (`operator.owed` in the books, `check-books.mjs` shows `operatorOwed`). No balance changes.
   Fees that would take more than half of the swept value are refused as a likely typo in
   `--fee-rate`; add `--high-fee` when you mean it (a thief bidding that high).
   If no running relayer acknowledges `HOLD` within `--wait` seconds (default 10), the command
   refuses and leaves `HOLD` in place: run it again once the relayer's log says it froze. Only when
   the service is really stopped, add `--relayer-stopped` (never while it runs: a relayer that has
   not frozen would overwrite the evacuation's journal). Every write also checks that nobody else
   wrote the state meanwhile. A false alarm caught before any sweep moved a coin (a refused rate, an
   explorer that did not answer) is undone with `murkle relayer evacuate --cancel`; once a sweep
   moved coins, finish the playbook instead. A stray `--bump` or `--cancel` on a relayer that is not
   evacuating changes nothing.
3. **Win the race.** Watch the sweeps (`murkle relayer status`, a block explorer). If a thief's
   transaction competes (`CONTESTED` in the output) or the sweep is slow, sign it again higher:
   `murkle relayer evacuate --bump --fee-rate <n>` (each bump must beat the last rate; its extra fee
   is booked the same way). An input that a thief already took in a block is reported `LOST`; the
   other coins are swept one by one. Running `evacuate` again first settles the sweeps already in a
   block (an earlier, cheaper version that won counts, with the difference back in the books), then
   re-sends what is journaled and sweeps anything left.
4. **Rotate** once every sweep has confirmed:

   ```sh
   murkle relayer rotate          # --accept-lost only for coins a thief took
   ```

   New pool and change keys (it refuses any key this relayer or the retired v1 relayer ever used),
   the books carried over unchanged under them, the old keys and state kept in
   `relay-balance/retired/g<N>/` (for late deposits; never pool money again), and
   `account-tags.key` written (every balance stays under its stored key). `HOLD` stays. Restart the
   service: the relayer starts frozen, publishes the new pool key in `/api/relay/info` with the old
   one in `balance.retiredPoolKeys`, answers balance reads, and refuses sends and credits with 503
   `pool_unfunded`. Wallets switch to deposit addresses of the new key and stop showing old ones.
5. **Refill the pool** from the cold wallet: every balance, reservation and the margin (the
   rotation prints the amount; `murkle relayer status` shows `shortfall`).

   ```sh
   murkle relayer refund-pool --from <cold key file> --dry-run
   murkle relayer refund-pool --from <cold key file>
   # or pay the amount by hand to the new change address, then:
   murkle relayer refund-pool --outpoint <txid:vout>
   ```

   The sweep paid the cold address the coins less the fees, so the cold wallet needs the
   difference from elsewhere: that is the operator's liability being paid. The refill is recorded
   as pool money (public in the ledger as `refund`), and counts only once it is in a block: a refill
   that is replaced or evicted never lets the relayer resume. After the payment, wait for a block
   and run `murkle relayer refund-pool --outpoint <txid:vout>` (the same outpoint) again; a second
   `--from` while one refill waits is refused (it would pay twice). Once I2 holds, the liability is
   marked paid and `HOLD` is removed. A rotation also credits, at once, every late deposit (step 7)
   whose sweep had confirmed but was not credited yet; the amount to refill includes it.
6. **Resume:** restart the service. Check `/api/relay/info` (`code` null, `depositsOpen` true) and
   `check-books.mjs` on the new `relayer.json`. Take a backup at once: it now holds
   `account-tags.key` and `retired/` (deploy/bin/backup.mjs adds them by itself).
7. **Late deposits.** A payment to an old deposit address is recorded (409 `deposit_retired`, the
   wallet keeps it pending), never credited from the old key. Sweep them into the new pool from
   time to time: `murkle relayer sweep-retired` (it holds the relayer for the moment it runs, with
   the same acknowledgement rule as `evacuate`; restart the service afterwards). Each is credited
   (value minus the usual sweep cost) once that sweep confirms; its fee is the operator's cost. When
   the margin cannot pay that fee, the part it cannot pay is the operator's liability again, and the
   deposits wait (deposit_retired, status `swept`) until the pool covers them: no other user's send
   is refused meanwhile. The command says so; refill with `murkle relayer refund-pool --from <cold
   key file>` or `--outpoint <txid:vout>` (after the first refill it holds the relayer the same way
   and lifts its `HOLD` at the end). One a thief spent first is reported lost and is not credited:
   decide case by case whether to make the user whole from your own funds. Wallets look for
   payments to the old addresses they showed (the web wallet on its deposit check, the CLI with
   `murkle relay credit`; `--older` looks at every address number), so a payment made from an
   exchange or another wallet is recorded too. During a later evacuation `sweep-retired` starts no
   new sweep (the change key may be compromised too); it resumes after the next rotation.

Keep `relay-balance/retired/` as long as anyone might still pay an old address. Never copy the
production keys anywhere else during all this (7.3), and never run two relayers on one directory.

**Communication template** (post it at step 2, update it at steps 4 and 6):

> **Relayer paused: moving funds to new keys.** On <date, time UTC> we found that the relayer's keys
> may be known to someone else. We have stopped all relayed sends and top-ups and moved the relay
> pool to an address only we control. **Your relay balance is safe and kept in full**; nothing is
> charged for this. Until we resume, pay the fee yourself (self-pay) or copy the envelope.
> **Do not pay any deposit address the relayer showed you before.** Your wallet shows a new one once
> we resume. A payment already made to an old address is credited after we have moved it.
> Next update: <time>. Questions: <contact>.

Resume notice:

> **Relayer back, with new keys.** Relayed sends and top-ups work again from <time UTC>. Balances
> carried over unchanged. Old deposit addresses are retired: your wallet shows only new ones. What
> happened: <short summary>. Transactions: <evacuation txids>.

### 10.5 Ceremony coordinator

The coordinator cannot forge a contribution: every accepted key is verified against the r1cs and the
phase-1 file, and anyone can re-verify the whole transcript (`scripts/ceremony/verify.mjs`). If its
host is compromised: pause the ceremony (`scripts/ceremony/admin.mjs --dir <dir> pause`), verify
the transcript and every published key from scratch on another machine, then resume from the last
verified key or restart the ceremony, and say which in the announcement channel (`docs/CEREMONY.md`).

### 10.6 Artifacts do not match the pins

The files under `build/` changed or a release was assembled wrongly. The wallet refuses to prove
with them. Re-fetch them with `scripts/fetch-artifacts.mjs` (every file is checked against the pins
before anything is written) or switch back to the previous release, then find out how they changed.

### 10.7 Disk full

The indexer cannot save its state when the disk is full and stops making progress. Free space (old
`archive/` files, journal vacuum `journalctl --vacuum-size=500M`, old backups already copied
off-site), then restart. On mainnet the node's block files grow by about 100 GB a year; plan for it.

### 10.8 Data source outage

With the Esplora source, a mempool.space outage stops the sync (`stale`); the API keeps serving the
last state. With your own node, check `bitcoin-cli getblockchaininfo` and its disk. Nothing needs to
be repaired after an outage: the indexer resumes at its height.

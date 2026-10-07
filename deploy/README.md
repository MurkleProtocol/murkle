# deploy/

Files for running a Murkle node. The procedures (install, upgrade, backups, the restore drill,
alerts, incidents) are in [docs/OPERATIONS.md](../docs/OPERATIONS.md); the launch sequence is in
`docs/MAINNET.md` and the ceremony in `docs/CEREMONY.md`. Mainnet has not launched; signet is the
default network.

| File | What it is for |
|---|---|
| `env/murkle.signet.env.example`, `env/murkle.mainnet.env.example` | `/etc/murkle/murkle.env` for the indexer, the monitor and the backups. No secrets: only paths to secret files. |
| `env/ceremony.env.example` | `/etc/murkle/ceremony.env` for the ceremony coordinator |
| `systemd/murkle-indexer.service` | the indexer and API (one process; the relayer runs inside it when switched on) |
| `systemd/murkle-indexer.service.d/relayer.conf.example` | the drop-in that switches the paid relayer on (`MURKLE_RELAYER=1`, `MURKLE_RELAY_MODE=balance`, its directory) |
| `systemd/murkle-ceremony.service` | the ceremony coordinator (`server/ceremony-server.mjs`) |
| `systemd/murkle-monitor.service`, `.timer` | `bin/monitor.mjs` every minute |
| `systemd/murkle-backup.service`, `.timer`, `murkle-backup@.path` | `bin/backup.mjs` hourly and when the relayer's books change (the path unit is a template: the instance is the network) |
| `systemd/murkle-backup.service.d/relayer.conf.example` | with the relayer: a backup without the relayer's keys and books fails |
| `journald/murkle.conf` | journal size and retention |
| `logrotate/murkle` | rotation for proxy error logs and other file logs |
| `caddy/Caddyfile` | HTTPS with automatic certificates, HSTS, the ceremony routes to the coordinator, the rest to the indexer |
| `nginx/murkle.conf` | the same for nginx with certbot |
| `bitcoin/bitcoin.conf.example` | Bitcoin Core for the RPC source: `txindex=1`, no prune, no wallet, RPC on localhost, cookie authentication |
| `docker/docker-compose.yml` | Bitcoin Core, the indexer and Caddy; profiles `ceremony` and `electrs` |
| `docker/bitcoind.Dockerfile` | Bitcoin Core from the official release tarball (version and sha256 required) |
| `docker/compose.env.example` | the compose settings (network, chain, Bitcoin Core release, domain) |
| `bin/backup.mjs` | `keygen`, `backup`, `restore`, `verify`: encrypted backups of the relayer's keys and books, the state and the headers |
| `bin/monitor.mjs` | health checks: lag, sync age, header errors, relayer halt (I2), artifacts, disk, coordinator |
| `bin/state-rollback.mjs` | rolls a state file back to a height through its undo journal (upgrade rollback) |
| `bin/check-books.mjs` | offline I2 check of a `relayer.json` and its key files (restore drill, incidents) |

`npm run monitor` and `npm run backup -- <command>` run the two tools from a checkout.

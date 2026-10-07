# Security policy

Murkle runs on the **signet test network**: its tokens and coins have no value. Every finding still matters, because it shapes what could ever go to mainnet.

## Report a vulnerability privately

- **Contact:** a private report through GitHub: https://github.com/MurkleProtocol/murkle/security/advisories/new (the same value as `SECURITY_CONTACT` in `src/params.mjs`, which the site's /security page shows).
- **Or:** a private security advisory on this repository (GitHub: Security tab, "Report a vulnerability").

Please include the affected component (circuit, indexer, wallet, CLI, relayer), steps to reproduce and the commit you tested. **Do not open a public issue and do not publish a working exploit** until a fix is out.

## Scope

In scope:
- the circuit (`circuits/`) and anything that lets a proof spend or mint what it should not (soundness, under-constrained signals, public-input aliasing);
- the indexer rules (`src/indexer.mjs`, `SPEC.md`): any way two honest replayers can reach different states, or a replayer can be stalled;
- the wallet (`web/src/`, `src/wallet.mjs`, `src/keys.mjs`): key handling, the vault, double spends through retries (invariant W-1), privacy leaks beyond those disclosed;
- the paid relayer (`server/relayer.mjs`, `server/relay-books.mjs`): any way the operator pays part of a user's transaction (invariant I-PAY), or one user's balance pays for another;
- the HTTP server: crashes, path traversal, header or CSP bypasses.

Known and disclosed, so not new findings on their own (see `audit/REPORT.md`):
- **A-8:** the phase-2 trusted setup is a DEV single-party contribution; whoever ran it could forge proofs until a public ceremony replaces it.
- **A-9:** chain data comes from an Esplora API (mempool.space by default) and proof-of-work is not checked yet.
- Mints and launches are public; the address that pays a transfer's fee is tied to it on Bitcoin; the anonymity set is small; a relayer sees IP addresses and timing and can link a top-up address to the transfers it relays.

## Supported versions

Only the latest commit of the default branch. There are no releases with security support yet.

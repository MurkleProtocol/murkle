# Contributing

## Set up, build and test

Requires Node.js 22 or later (`.nvmrc`).

```bash
npm ci                                              # exact dependencies from package-lock.json
npm run artifacts:fetch -- --from <base URL>        # the pinned circuit artifacts, checked against src/pins.json
npm test                                            # the whole suite (node --test), no network needed
npm run web:build                                   # writes web/src/facts.json and builds web/dist
npm run dev                                         # indexer API on :8787 + web app on :5173
npm run prepublish:check                            # what a commit would publish, and anything that must not be
```

- The base URL is a GitHub release of this repository (`https://github.com/<owner>/<repo>/releases/download/<tag>`) or any Murkle site's `/artifacts` (see README, "Quick start"). The zkey cannot be rebuilt, so the tests need these files.
- Tests use fakes only: `FakeEsplora`, synthetic blocks, temporary directories, fake storage and a fake DOM. A test must never touch the network, `data/`, a real wallet, or ports 8787 and 5173 (bind port 0).
- A change to the circuit is a re-genesis: new artifacts, new pins, a new genesis ATTEST. Do not change `circuits/`, `src/pins.json` or the indexer rules in an ordinary pull request; open an issue first.

## Rules for every file

- **English only**, in code, comments, UI copy, errors, tests and docs. `test/english.test.mjs` fails on any Cyrillic character.
- **Honest copy.** Follow `docs/CLAIMS.md` and `docs/design/visual.md` §2: never "Bitcoin verifies the proofs", "trustless", "fully anonymous", "untraceable", "audited" without "internally", "mainnet-ready", any anonymity percentage, or "free"/"sponsored" relaying; keep every required disclosure (signet, the DEV setup A-8, no proof-of-work check A-9, public mints, the small anonymity set). Tests check the parts a test can check.
- **Users always pay their own fees.** No change may make the operator pay any part of a user's transaction (invariant I-PAY, `audit/REPORT.md` R-3).
- **Code style.** ESM; `.mjs` in `src/`, `server/`, `bin/`, `scripts/`; `.js` in `web/src`; 2-space indent; small modules; comments explain why. No new runtime dependencies without a reason in the pull request.

## Line endings

Some files are CRLF and the rest are LF, and tests assert those bytes. `.gitattributes` (`* -text`) stores every file byte for byte, so git never converts them; keep each file's line endings when you edit it (an editor that "normalises" a whole file breaks tests).

CRLF files:
- `bin/murkle.mjs`
- `scripts/build-circuit.mjs`, `scripts/demo-a6-copy.mjs`, `scripts/facts.mjs`
- `src/btc/esplora.mjs`, `src/envelope.mjs`, `src/indexer.mjs`, `src/keys.mjs`, `src/store-node.mjs`, `src/verify-tx.mjs`
- `test/block.test.mjs`, `test/launchpad.test.mjs`, `test/verify-tx.test.mjs`, `test/web-ui.test.mjs`
- `web/src/app.js`, `web/src/config.js`, `web/src/relay.js`, `web/src/session.js`
- `web/src/share/`: `charts.js`, `launch-card.js`, `live-check.js`, `markdown.js`, `public.css`, `wall.js`
- `web/src/styles/components.css`, `web/src/styles/pages.css`
- `web/src/ui/`: `components.js`, `icons.js`, `kit-view.js`, `proofprint.js`, `rootmatch.js`, `seal.js`, `sheet.js`
- `web/src/verify/`: `engine.js`, `my-view.js`, `replay.worker.js`, `verify.css`
- `web/src/views/`: `app-create.js`, `app-import.js`, `app-launch.js`, `app-send.js`, `app-shared.js`, `explorer.js`, `landing.js`, `lookup.js`, `receipt.js`, `verify.js`

Mixed (keep each line as it is): `test/fix-wallet-core.test.mjs`. Every other text file is LF, and new files are LF.

Check a file before committing:

```bash
node -e "const b=require('fs').readFileSync(process.argv[1],'latin1');console.log('CRLF',(b.match(/\r\n/g)||[]).length,'LF',(b.match(/\n/g)||[]).length-(b.match(/\r\n/g)||[]).length)" <file>
```

## Secrets

Never commit keys, wallets or relayer state. `data/` (chain state, CLI wallets, relayer keys) and `build/` are ignored, and `.gitignore` also ignores `*.key`, `wallets/`, `relay-balance/` and `.env*` anywhere. Keep `MURKLE_DATA_DIR` and the `MURKLE_RELAY_*` paths outside the checkout, never use `git add -f`, and run `npm run prepublish:check` before pushing. The check flags any 64-hex value on or right after a line that names a key, secret or seed; a public test vector there needs the marker `prepublish-ok` in a comment on that line or the line above.

## Security issues

Report them privately: `SECURITY.md`.

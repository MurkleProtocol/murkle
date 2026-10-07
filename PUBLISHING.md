# Publishing checklist (public GitHub repository)

Everything below is prepared except the steps marked **OWNER**: those need a decision or an account, and nothing has been uploaded anywhere. Work through them in order. This file can stay in the repository afterwards as the release checklist, or be deleted.

Commands are for Git Bash or any POSIX shell, run from the repository root.

## 1. Choose the license (OWNER)

Done (2026-10-04): the owner chose GPL-3.0-or-later. `LICENSE` holds the unmodified text from gnu.org (sha256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`), `package.json` says `GPL-3.0-or-later`, and `LICENSE-CHOICE.md` is deleted. Still open here: replace `TODO_COPYRIGHT_HOLDER` in `README.md` with the copyright holder.

## 2. Choose the GitHub account and repository name (OWNER)

Say `<owner>/<repo>`, for example `<owner>/murkle`. Then three one-line edits:

| File | Line | Set to |
|---|---|---|
| `src/params.mjs` | `export const REPO_URL = null;` | `export const REPO_URL = "https://github.com/<owner>/<repo>";` (no trailing slash) |
| `package.json` | `"url": "git+https://github.com/TODO_OWNER/TODO_REPO.git"` | `"url": "git+https://github.com/<owner>/<repo>.git"` |
| `README.md` | the clone line in "Quick start" (`TODO_OWNER/TODO_REPO`) | your `<owner>/<repo>` |

What the site shows once `REPO_URL` is set (after `npm run web:build` and a restart of the indexer):
- the footer gets a "Repository" link and a "Source" item;
- `/protocol` gets a "Source" button;
- `/verify#run` ("Run the same rules on your own machine") starts with `git clone <REPO_URL> murkle && cd murkle`, uses `npm ci` and `npm run artifacts:fetch -- --from <this site>/artifacts`, and says the indexer is open source;
- `/security` points vulnerability reports to a private security advisory on the repository, unless `SECURITY_CONTACT` is set (step 3);
- `npm run artifacts:fetch` with no other source downloads from `<REPO_URL>/releases/download/artifacts-41d28d8899f3` (step 7).

## 3. Choose the security contact (OWNER)

An email address or an https URL you will read, then two one-line edits:

| File | Line | Set to |
|---|---|---|
| `src/params.mjs` | `export const SECURITY_CONTACT = null;` | `export const SECURITY_CONTACT = "security@your-domain";` (or `"https://…"`) |
| `SECURITY.md` | `TODO_SECURITY_CONTACT` | the same address |

`/security` then says: "Please report vulnerabilities privately to <contact>, with steps to reproduce." Also turn on private vulnerability reporting in the repository settings (step 6), which `SECURITY.md` offers as the second channel.

## 4. Check the owner-only bits (OWNER)

- `.prepublish-deny` (gitignored, never published) lists values that must never appear in a published file. It holds your own signet address as `prefix...suffix`; add any other address, name, email or host of yours, one per line.
- `scripts/build-circuit.mjs` downloads the public Powers of Tau file from Google's bucket or, as a fallback, from a release in the GitHub repository `hilawe/dash-mno-verify` (an unrelated third party; the file is accepted only if both pinned hashes match). Confirm that account is not yours. Optionally add your own mirror later (step 7).
- `docs/internal/` (gitignored) holds the build plan, the feature brief and the naming research. They stay private; nothing in the code or the tests reads them.
- Decide whether `docs/design/` is published as it is. It was edited for a public audience: the agent-workflow rules, owner notes and local paths are gone, and each file says whether it is current, historical or superseded (`docs/design/README.md`).

## 5. Run the pre-publication check

```bash
npm ci
npm run artifacts:check          # the pinned files are present (this machine has them in build/)
npm test
npm run prepublish:check -- --final
```

`--final` fails while any owner decision is open (no `LICENSE`, `LICENSE-CHOICE.md` still present, `REPO_URL` or `SECURITY_CONTACT` null, a `TODO_` placeholder left). It also fails on anything that must not be published: files under `data/`, `build/`, `docs/internal/`; key, wallet, `.env` or relayer-state files; files over 1 MB; secret-like values (including any 64-hex value next to a key, secret or seed name, unless marked `prepublish-ok`); any secret from this checkout's `data/` (whole, as a 16+ digit fragment, or as raw bytes in a binary file), the keys and addresses derived from it (P2TR, x-only key, shielded address, relay account key and id) and the ids in the wallet and relayer state files; values from `.prepublish-deny`; absolute local paths; emails other than example domains; Cyrillic. It never prints a matched value.

## 6. Create the repository and push (OWNER)

Start the public history from a clean tree. `.gitattributes` (`* -text`) keeps every file byte for byte, whatever `core.autocrlf` says; the tests depend on that.

```bash
git init -b main
git add -A
git status --ignored --short | grep '^!!' | grep -E '^!! (data|build|docs/internal)/' # listed as ignored: good
git ls-files | grep -E '^(data|build|docs/internal)/|\.key$|wallets/|relay-balance/|\.env' # must print nothing
npm run prepublish:check -- --final          # now reads the list from git ls-files
git update-index --chmod=+x bin/murkle.mjs   # optional: lets Linux users run ./bin/murkle.mjs (its shebang line is CRLF, so `node bin/murkle.mjs` stays the documented way)
git commit -m "Murkle: initial public release"
```

Never use `git add -f`. On GitHub, create an **empty** public repository `<owner>/<repo>` (no README, license or .gitignore from the web form), then:

```bash
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

Repository settings: Security, enable "Private vulnerability reporting"; enable Dependabot alerts; optionally protect `main`.

## 7. Publish the artifacts release (OWNER)

The pinned zkey cannot be rebuilt, so a fresh clone needs it from a release. Prepare the files outside the repository:

```bash
npm run release:assets -- --out ../murkle-release-assets
```

It copies `manifest.json`, `verification_key.json`, `transaction.wasm` and `transaction.zkey` from `build/`, checks each against `src/pins.json`, and writes `SHA256SUMS` and `RELEASE-NOTES.md`. It refuses an output directory inside the repository and uploads nothing.

On GitHub, create a release with the tag **`artifacts-41d28d8899f3`** (printed by the script: `artifacts-` plus the start of `manifestSha256`; `artifacts:fetch` looks for exactly this tag under `REPO_URL`) on the first commit, paste `RELEASE-NOTES.md` as the description, and attach the four files and `SHA256SUMS`. With the GitHub CLI that would be `gh release create artifacts-41d28d8899f3 ../murkle-release-assets/* --title "Pinned circuit artifacts" --notes-file ../murkle-release-assets/RELEASE-NOTES.md`.

Check it from a fresh clone in another directory:

```bash
git clone https://github.com/<owner>/<repo>.git murkle-check && cd murkle-check
npm ci && npm run artifacts:fetch && npm test
```

Optional: also attach `powersOfTau28_hez_final_15.ptau` (from `build/ptau/`, 37.8 MB) and add its release URL to `PTAU.urls` in `scripts/build-circuit.mjs`, so the Powers of Tau download no longer depends on third parties.

## 8. Set the CI variable (OWNER)

Repository settings, Secrets and variables, Actions, **Variables**: add `MURKLE_ARTIFACTS_URL` = `https://github.com/<owner>/<repo>/releases/download/artifacts-41d28d8899f3`. Until it is set, `.github/workflows/test.yml` installs, prints a notice that tests are skipped, and still runs the publication check. Re-run the workflow once it is set: it then tests on Ubuntu and Windows with Node 22 and 24. Optional hardening: pin `actions/checkout`, `actions/setup-node` and `actions/cache` to full commit SHAs instead of the `@v4` tags.

Also try the container once (it was prepared but not built on the preparing machine): `docker build -t murkle-indexer .` and the `docker run` line in the README, section "Run an indexer with Docker".

## 9. Rebuild and restart the site (OWNER)

On the server that hosts the site:

```bash
npm ci
npm run web:build      # picks up REPO_URL and SECURITY_CONTACT, copies the notices into web/dist
# restart the indexer (npm run indexer, or the Docker container)
```

Then open `/security`, `/protocol` and `/verify#run` and check the repository link, the contact and the clone command; `/THIRD_PARTY_NOTICES.txt` and `/LICENSE.txt` are served from the built site.

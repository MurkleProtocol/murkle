# Murkle web design spec (signet web: landing, public explorer, wallet)

**Direction.** A graphite "cryptographic instrument" look. The page's real work, re-verifying a Bitcoin transaction in front of the visitor, is the hero; there is no neon or glow to bury it.

The visual interest comes from real data turned into art, not from effects:
- the Dual Seal emblem,
- Proofprint rosettes,
- the envelope byte mosaic,
- a merkle lattice that lights up on real blocks,
- a provenance chip that visibly upgrades from IDX to YOU when your browser finishes a check.

**Fixed choices:**
1. Provenance chips **BTC / YOU / IDX** and the IDX→YOU upgrade micro-interaction.
2. The launchpad layer: deterministic token sigils, launch cards with status pills, a shareable token page at `/t/TICKER`, and a share kit (receipt PNG, launch card PNG, embed widget).
3. Private payment links whose data lives in the URL `#fragment`.
4. Self-hosted fonts and a strict CSP. A privacy wallet must not contact a font CDN on load.
5. The binding copy rules (banned and approved words), the three-column trust model, the "What Bitcoin sees" comparison, the FAQ voice, and the closing line "Your bag. Your business."

**Not used:** neon or violet brand colours, lime, brand gradients, glows, glow orbs, grain, rotating conic borders, odometers and count-ups in the app, and gradient sheens.

---

## 1. Facts the design relies on

- **Vault.** `web/src/keystore.js` uses scrypt (N=65,536, r=8, p=1, about 64 MiB) and XChaCha20-Poly1305, with a minimum password length of 8. UI copy reads the parameters from `keystore.KDF` at runtime and never hardcodes them.
- **Numbers come from facts.json.** Never hardcode the test count or any other figure that drifts.
  - `scripts/facts.mjs` runs before `web:build` and writes `web/src/facts.json`:
    - testCount (static count of `test(` calls);
    - constraints (from the `build/transaction.r1cs` header);
    - sha256 and size of `verification_key.json`, `transaction.zkey` and `transaction.wasm`;
    - circuit params (depth 32, 2-in/2-out, Groth16/BN254);
    - the audit findings summary.
  - The landing page, the footer and /security read only from facts.json.
- **Envelope sizes:**

  | Envelope | Size |
  |---|---|
  | TRANSACT | 471 B |
  | MINT | 507 B (bindOutpoint 36) |
  | MINT_SCRIPT | 503 B (bindScriptHash 32) |
  | DEPLOY | 36 + ticker + treasury bytes, about 73 B for a 3-char ticker with a P2TR treasury |

  - The carrier transaction is about 600 vB; the compressed proof is 128 B.
  - The TRANSACT layout is: header 5 (magic 3, version 1, op 1), h_anchor 4, publicAsset 8, publicAmount 8, nullifier 2×32, commitment 2×32, noteCiphertext 2×95, proof 128.
- **Anchor roots:** the indexer keeps the root of every height (SPEC §6). The receipt reads them in fixed 2000-height pages from `/api/roots?from&to` (pool-data `rootsAll`) and never asks the indexer for one height: the anchor would tell it which transaction you opened.
- **/api/log entries** of transfers (TRANSACT) carry no ticker, asset or amount; DEPLOY and MINT entries carry `asset` and `ticker` (`docs/API.md`).
- **The relayer can only pay for TRANSACT.**
  - MINT pays sats to the treasury and is bound to the payer's input or script, so the payer is always public.
  - DEPLOY is public by design.
  - The UI must say both.
- **The sender cannot decrypt their own outputs** (there is no outgoing viewing key). "My view" on a sent transfer comes from the sealed local history and is labelled "from your history on this device", not "decrypted".
- **Unisat on signet** rejects the large OP_RETURN (old relay policy). Show this inline on the Unisat payer card while on signet.

## 2. Copy rules (binding; the design enforces them)

- **Master claim:** "Proof on Bitcoin. Verified by you." Say "Privacy you can check on Bitcoin.", never "anonymity verified on-chain".
- **Never** say "Bitcoin verifies the proof". Bitcoin stores and orders the data. The rules are enforced by deterministic replay (the Runes/Ordinals model), and anyone can re-run them.
- **"Verified" and solid green** are reserved for checks the viewer's own browser ran. A result the indexer reported is "Accepted by indexer", shown as an outline with a [Verify] button next to it.
- **Every check and every live number** carries a chip that names what you still have to trust for that line:
  - `BTC`: Bitcoin data served by mempool.space.
  - `YOU`: only your browser's math.
  - `IDX`: our indexer's claim.
- **Banned words:** untraceable, 100% anonymous, fully anonymous, unhackable, bank-grade, military-grade, trustless, "audited" on its own, "Bitcoin verifies".
- **Approved words:** private, shielded, hidden by proof, proof on Bitcoin, verified in your browser, recomputed from Bitcoin data, reported by our indexer, internally reviewed, unlinked (relayer-paid transfers only).
- **No fake numbers.** While data loads, show a skeleton or "—". Never count up from zero to a placeholder.
- **English only, en-US formatting.** UI is sentence case; uppercase only in mono eyebrows and chips.
- **Error pattern:** "What happened. What to do."
- **Signet status and the dev setup** are always visible: in the ribbon, the footer and /security.

**Error messages:**

| File | Message |
|---|---|
| payers.js | Unisat extension not found in this browser. |
| payers.js | Update Unisat to 1.4 or later for signet support. |
| payers.js | Unisat can pay only one output per transaction. |
| payers.js | Unisat's signet node rejected the large OP_RETURN (old relay policy). On signet, pay with the built-in key, or copy the envelope. |
| session.js | Invalid amount: at most ${div} decimal places. |
| session.js | Root mismatch: the tree rebuilt in your browser differs from the indexer's. Sync again, or switch indexer in Settings. |
| session.js | Choose a fee payer: built-in key or Unisat. |
| session.js | Ticker ${t} is already taken. |
| app-send.js | Amount must be greater than zero. |

## 3. Design tokens: `web/src/styles/tokens.css` (copy verbatim)

```css
:root {
  color-scheme: dark;
  /* ink */
  --bg:#0A0B0D; --bg-lattice:rgba(232,235,238,.035);
  --surface-1:#101215; --surface-2:#15181C; --surface-3:#1B1F24; --surface-inset:#0C0E10;
  --line:#23272D; --line-strong:#333941;
  --text:#E8EBEE; --text-2:#A2AAB4; --text-3:#7A828C;
  --inverse:#E8EBEE; --inverse-hover:#FFFFFF; --inverse-ink:#0A0B0D;
  /* bitcoin: chain data + chain-writing actions only */
  --btc:#F7931A; --btc-hover:#FFA53D; --btc-press:#E2830F; --btc-text:#F7931A; --btc-ink:#1A0E00;
  --btc-wash:rgba(247,147,26,.10); --btc-line:rgba(247,147,26,.38);
  /* proof: "checked" only */
  --proof:#3FD8A0; --proof-text:#3FD8A0; --proof-ink:#03140D;
  --proof-wash:rgba(63,216,160,.10); --proof-line:rgba(63,216,160,.36);
  /* status */
  --link:#8DB0FF; --focus:#9FB8FF;
  --warn:#E9B949; --warn-wash:rgba(233,185,73,.10); --warn-line:rgba(233,185,73,.36);
  --danger:#F26B5E; --danger-wash:rgba(242,107,94,.10); --danger-line:rgba(242,107,94,.40);
  /* redaction */
  --redact:#262B31; --redact-hatch:rgba(255,255,255,.07);
  --hatch:repeating-linear-gradient(135deg,var(--redact-hatch) 0 2px,transparent 2px 6px);
  /* envelope anatomy (byte grid + legend only) */
  --f-header:#9AA3AD; --f-anchor:#F7931A; --f-public:#C3A6FF; --f-bind:#E9B949;
  --f-nullifier:#FF8F8A; --f-commitment:#6FC3FF; --f-cipher:#7D8794; --f-proof:#3FD8A0;
  /* token sigils (identity only; never orange/green/red) */
  --sg-1:#7FA7FF; --sg-2:#B79CFF; --sg-3:#F28DB5; --sg-4:#5CC8E0; --sg-5:#D8C59A; --sg-6:#A9B4C0;
  /* misc */
  --scrim:rgba(5,6,8,.72); --qr-tile:#FFFFFF; --qr-ink:#0A0B0D;
  --shadow-1:none;
  --shadow-pop:0 16px 40px rgba(0,0,0,.55),0 0 0 1px var(--line-strong);
  /* type */
  --font-display:"Instrument Serif","Iowan Old Style",Georgia,serif;
  --font-ui:"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,"Cascadia Code",Consolas,monospace;
  /* space (4px grid) */
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px; --s8:72px; --s9:96px;
  --gutter:16px;
  /* shape */
  --radius-s:6px; --radius-btn:8px; --radius:10px; --radius-l:14px; --radius-pill:999px;
  /* layout */
  --max-public:1120px; --max-app:880px; --max-form:640px;
  --h-ribbon:28px; --h-top:56px; --h-ledger:32px; --h-tabbar:64px; --w-rail:232px; --w-rail-compact:64px; --w-inspector:320px;
  --z-sticky:30; --z-pop:40; --z-sheet:50; --z-toast:60;
  /* motion */
  --ease:cubic-bezier(.2,.7,.2,1);
  --d-press:120ms; --d-ui:180ms; --d-sheet:240ms; --d-chip:300ms; --d-stamp:500ms;
}
@media (min-width:768px){ :root{ --gutter:24px; } }
@media (min-width:1024px){ :root{ --gutter:32px; } }

/* LIGHT: identical block in both selectors */
:root[data-theme="light"] { /* LIGHT */ }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { /* LIGHT */ } }
/* LIGHT =
  color-scheme:light;
  --bg:#F6F5F1; --bg-lattice:rgba(17,19,22,.045);
  --surface-1:#FFFFFF; --surface-2:#F2F1EC; --surface-3:#E9E7E1; --surface-inset:#F0EEE8;
  --line:#E3E0D8; --line-strong:#CBC7BD;
  --text:#111316; --text-2:#48505A; --text-3:#646B74;
  --inverse:#111316; --inverse-hover:#2A2E34; --inverse-ink:#F6F5F1;
  --btc:#E8820C; --btc-hover:#D27300; --btc-press:#BD6800; --btc-text:#A85400; --btc-ink:#1A0E00;
  --btc-wash:rgba(232,130,12,.09); --btc-line:rgba(168,84,0,.34);
  --proof:#0E9F6E; --proof-text:#0B7F58; --proof-ink:#03140D;
  --proof-wash:rgba(14,159,110,.09); --proof-line:rgba(11,127,88,.34);
  --link:#2C56C9; --focus:#2C56C9;
  --warn:#9A6500; --warn-wash:rgba(154,101,0,.08); --warn-line:rgba(154,101,0,.32);
  --danger:#C2392D; --danger-wash:rgba(194,57,45,.08); --danger-line:rgba(194,57,45,.34);
  --redact:#DAD7CF; --redact-hatch:rgba(17,19,22,.08);
  --f-header:#5E6670; --f-anchor:#B65F00; --f-public:#7A4FD0; --f-bind:#8E6200;
  --f-nullifier:#C2413F; --f-commitment:#1F72B8; --f-cipher:#8A929B; --f-proof:#0B8A5F;
  --sg-1:#3D66D6; --sg-2:#7A4FD0; --sg-3:#C2457E; --sg-4:#157F99; --sg-5:#8A7440; --sg-6:#5E6670;
  --scrim:rgba(17,19,22,.45);
  --shadow-1:0 1px 2px rgba(17,19,22,.05);
  --shadow-pop:0 1px 2px rgba(17,19,22,.06),0 14px 36px rgba(17,19,22,.12);
*/
```

**Contrast**, verified at 4.5:1 or better:
- text-3 on bg is about 5.0 (dark) and 4.9 (light).
- btc-text #A85400 on white is about 5.3.
- proof-text #0B7F58 on white is about 5.0.
- btc-ink on the #E8820C fill is about 7.0.
- proof-ink on the #0E9F6E fill is about 5.6.

**Base rules (`base.css`):**
- `html,body{background:var(--bg);color:var(--text);font:400 15px/24px var(--font-ui)}`
- `.mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums slashed-zero;font-feature-settings:"zero" 1;overflow-wrap:anywhere}`
- Every flex and grid child gets `min-width:0`.
- `:focus-visible{outline:2px solid var(--focus);outline-offset:2px}`
- `::selection{background:var(--btc-wash)}`
- Orange text in light mode always uses `--btc-text`; `--btc` is for fills only.
- Solid green fills always carry `--proof-ink` text.
- QR codes are always `--qr-ink` on a `--qr-tile` with 12px padding, in both themes.

**Theme:**
- `web/public/theme-boot.js` is loaded blocking in `<head>`. It is a separate file because the CSP forbids inline script: `try{var t=localStorage.getItem("ui.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`
- With no attribute, the system theme applies; dark is the default.
- The toggle is System / Dark / Light, in the footer, in Settings, and as a top-bar icon on desktop.

## 4. Typography

**Fonts are self-hosted** (`npm i @fontsource/instrument-sans @fontsource/instrument-serif @fontsource/jetbrains-mono`). Import latin subsets only:
- instrument-sans `latin-400/500/600/700.css`
- instrument-serif `latin-400.css` and `latin-400-italic.css`
- jetbrains-mono `latin-400/500/600.css`

**Preload:** serif 400, sans 400 and 500, mono 400. The reference URL below is for prototypes and design tools only; production never calls Google:
`https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap`

**Roles:**
- **Instrument Serif:** the landing H1 and H2, the receipt hero headline, and the share images, nothing else. Italic is allowed on one phrase per headline.
- **Instrument Sans:** all UI text, plus tickers (700, uppercase, +0.02em; no "$" in the app; "$TICKER" only in X share text).
- **JetBrains Mono:** all data: hashes, txids, addresses, nullifiers, commitments, amounts, sats, heights, envelope bytes, transcripts, eyebrows and chips.

| Token | Spec |
|---|---|
| eyebrow | mono 500 11/16, uppercase, +0.08em, --text-3 |
| chip | mono 600 10/14, uppercase, +0.08em |
| caption | sans 12/16 |
| small | sans 13/18 |
| dense | sans 14/20 |
| body | sans 15/24 |
| lead | sans 17/28, --text-2, max 62ch |
| h3 | sans 600 18/24 |
| h2-app | sans 600 22/28 |
| h1-app | sans 600 28/34, -0.015em |
| display (landing H1) | serif 400 clamp(44px,8vw,84px)/1.02, -0.02em |
| h2-landing | serif 400 clamp(30px,4.5vw,48px)/1.08, -0.01em |
| receipt hero | serif 400 clamp(36px,6vw,56px)/1.05 |
| hero number | mono 500 clamp(28px,6vw,40px); unit sans 13 --text-3 |
| mono data | 13 in tables, 14 in panels |
| ticker card / token page | sans 700 20 / clamp(32px,6vw,48px) |
| inputs | never below 16px on phones |

**Formatting helpers (`web/src/ui/format.js`):** every `toLocaleString()` is replaced; everything is fixed to en-US.
- `int`: `Intl.NumberFormat("en-US")`, giving "1,284".
- `units(bigint, div)`: "12,500.25". Group the integer part from the BigInt; trim trailing zeros.
- `sats(n)`: "1,240 sats".
- `height(h)`: "#263,104" in --btc-text.
- `date(ms)`: `Intl.DateTimeFormat("en-US",{dateStyle:"medium",timeStyle:"short"})`, giving "Oct 2, 2026, 2:05 PM".
- `rel(ms)`: "12 s ago", "4 min ago", "3 h ago", "2 d ago". `relBlocks(n)`: "3 blocks ago".
- `hash(hex)`: 8 head + "…" + 8 tail. Head and tail in --text, ellipsis in --text-3, full value in `title`, plus a copy button.
- `chunks(hex)`: groups of 4 separated by a 0.25ch gap, wrapping with `overflow-wrap:anywhere`.
- `addr(address)`: "mrk1" plus chunked body. The first 6 and last 6 characters are in --text, the middle in --text-2.
- `bytes(n)`: "471 bytes", "12.3 MB" (decimal).
- Hashes stay lowercase even inside uppercase strips (`.hash{text-transform:none}`).

## 5. Layout system and shell

**Grid and breakpoints:**
- Breakpoints: phone under 768, tablet 768–1023, desktop 1024 and up, wide 1280 and up.
- Gutters: 16, 24 and 32px.
- Containers: public pages 1120px; wallet content 880px; forms 640px.
- Section rhythm: landing 96px (64 on phones); app 32px (24 on phones).
- Tap targets are at least 44px.
- No horizontal scroll at 320px or wider:
  - tables restack as cards under 720px;
  - the envelope grid uses container queries;
  - card grids use `repeat(auto-fill,minmax(min(100%,300px),1fr))`;
  - bars and sheets use safe-area padding.
- Test at 320, 375, 414, 768 and 1280px in both themes.

**Shell, top to bottom:**

1. **Honesty ribbon** (28px, every page, not dismissible, scrolls away).
   - Background: --warn-wash plus the --hatch overlay. Text: mono 11 uppercase in --warn.
   - Desktop: "SIGNET TEST NETWORK · TEST COINS ONLY · DEVELOPMENT PROVING KEYS · What this means →" (links to /security#status).
   - Phone: "SIGNET · TEST COINS · DEV KEYS →".
2. **Top bar** (56px, sticky, solid --bg, 1px --line bottom, no blur).
   - Left: the glyph, the wordmark (sans 600 17px, -0.01em) and a "SIGNET" chip (mono 10, warn outline, radius 4, height 20).
   - Nav (desktop and up): Mints · Explorer · Verify · Security, in sans 500 14 --text-2. The active item is --text with a 2px --text underline flush with the bar bottom.
   - Search, by width:
     - desktop: a 280px field, placeholder "Search txid, nullifier, ticker", with a `/` hint;
     - tablet: an icon that opens a sheet;
     - phone: an icon in the top bar.
   - Right: the Root Match chip, a theme icon button (desktop), and the wallet button:
     - no wallet: "Open wallet" (neutral primary, 32px);
     - locked: "Unlock" with a lock icon (secondary);
     - unlocked: a 20px sigil of the user's address hash plus "Wallet" and a chevron. The menu holds Portfolio, Settings and Lock now.
3. **Ledger strip** (32px, tablet and up). It is sticky inside /app and /explorer and static elsewhere.
   - Style: --surface-inset with a 1px --line bottom. Labels are mono 11 uppercase --text-3; values are --text-2; heights are --btc-text; the ✓ is --proof-text only when the root is YOU-verified.
   - Content: `SIGNET #263,104 · ROOT 1a2b3c4d…9f8e ✓ REBUILT IN YOUR BROWSER · 1,284 NOTES · 312 SPENT · 7 TOKENS · SYNCED 12 S AGO ●`
   - On overflow, items hide right to left in the order SYNCED, TOKENS, SPENT (via container queries). It never wraps or scrolls.
   - The ● is the product's only looping animation.
   - Phone: hidden. The compact Root Match chip opens a bottom sheet with the same readout.
4. **Main.**
5. **Footer** (see §10.12).
6. **Phone bottom tab bar** (64px plus safe area, --surface-1, 1px --line top; icon 20 and label 11):
   - Public pages: Mints · Explorer · Wallet (center) · Verify · More. More is a sheet with Security, Protocol, Theme and Source.
   - Inside /app: Portfolio · Send · Mint · Activity · More. More holds Receive, Launch, Notes, Settings and "Back to site".

**Wallet layout by width:**
- Desktop: a 232px left rail (Portfolio, Send, Receive, Mint, Launch, Activity, Notes, Settings; at the bottom, a "Lock" button) plus content capped at 880px.
- Wide: adds a 320px Inspector column (P2) with pool health, the last operation's seal and the anonymity meter.
- Tablet: the rail collapses to 64px icons with tooltips.

**Wordmark and glyph:**
- The glyph is a 20px rounded-square outline (radius 5, stroke 1.5, --text) containing a 3-node merkle branch:
  - leaves are hollow circles of r 1.75 at (6.5,14) and (13.5,14);
  - 1.5px lines join them to the root at (10,7);
  - the root is a solid --btc dot of r 2.25 (the "sealed root").
- Favicon (`web/public/favicon.svg`): the same glyph on a #0A0B0D square of radius 7 at 32px, with #E8EBEE strokes and a #F7931A root.
- The name stays a placeholder until roadmap 3. The current slot shows "zkpool"; `config.BRAND` drives everything.

## 6. The "verified on-chain" system (signature components)

### 6.1 Provenance chip `.prov`
- **Shape:** 18px tall, padding 0 6px, **radius 4** (deliberately not a pill, so it never reads as a status), 1px border, a 9px glyph, and the chip type style.
  - `BTC`: cube glyph, --btc-text on a --btc-line border.
  - `YOU`: check glyph, --proof-text on a --proof-line border.
  - `IDX`: server glyph, --text-3 on a --line-strong border.
- **Popover** (tap or hover; one sentence):
  - BTC: "Bitcoin data fetched from mempool.space. Your browser checked it, but you still trust that source for the block header."
  - YOU: "Computed in your browser. Nothing to trust but your own machine."
  - IDX: "Reported by our indexer. Your browser hasn't checked this yet."
- **IDX→YOU upgrade:** 300ms crossfade of glyph, label and border. This is the product's key micro-interaction. Only a check against Bitcoin data upgrades a chip: your own replay (Verify the Pool), or a proof or inclusion check of raw transactions. A tree rebuilt in the browser from the commitments the indexer serves, matching the root it reports, is **not** an upgrade: it stays `IDX` with the rebuild tip (`REBUILD_TIP` in `ui/prov.js`): "its list and its root agree. Only Verify the Pool checks them against Bitcoin." A rebuild that **differs** is the browser catching the indexer, so a mismatch is shown as `YOU`.
- **Where chips appear:** every stat, root, verdict, transcript row and balance-source line.

### 6.2 Dual Seal (the brand emblem and the "verified on Bitcoin" badge)
The seal has two halves. **Left = ON BITCOIN** (orange); **right = VERIFIED** (green). The honesty gradient: an outline means someone else says so; a solid fill means your browser checked it.

**States:**

| State | Left: ON BITCOIN | Right: VERIFIED | Text (always present; color is never the only signal) |
|---|---|---|---|
| mempool | dashed --btc-line outline | --line dashed, grey | "In mempool" · "Awaiting block" |
| mined, indexer pending | solid (wash + 3px band) | grey dotted | "#263,104 · 1 conf" · "Waiting for indexer" |
| indexer accepted | solid | 1.5px --proof-line outline, --proof-text | "#263,104 · 3 conf" · "Accepted by indexer" + [Verify] |
| browser verified | solid | **solid --proof fill, --proof-ink text** | "#263,104 · 3 conf" · "Verified in this browser · 412 ms" |
| rejected by indexer | solid | --danger-wash, --danger-line | "Rejected: Nullifier already spent" |
| browser disagrees with indexer / root mismatch | whole seal in --danger | | "Do not trust this indexer" + link to the public indexer switch (/verify#indexer, no wallet needed) |
| dropped | both grey | | "Dropped from mempool" |
| DEPLOY (no proof) | as above | label "Terms checked in this browser" | |

**Variants:**
- **Pill (24px, lists).** Two joined segments with radius 999 and a 1px border per segment.
  - Left: a 12px block glyph and "#263,104" in mono 11. Mempool shows "mempool".
  - Right: a 12px proof glyph plus `YOU` (solid), `IDX` (outline), `WAIT` (grey) or `REJ` (danger).
  - `aria-label` example: "Mined in block 263,104, 3 confirmations. Proof verified in this browser."
- **Block (72px; receipts, the wallet header, the Disclosure Preview result).** Two equal cells with radius 10.
  - Each cell has an eyebrow ("ON BITCOIN" / "VERIFIED"), a value line (mono 14 "#263,104" / sans 14 "in this browser") and a caption ("3 confirmations · 612 vB" / "Groth16 · 9 ms").
  - Left cell when mined: --btc-wash background and a 3px solid --btc left band.
  - Right cell when YOU: solid --proof with --proof-ink text.
  - Right cell when IDX: --proof-line 1.5px border with a [Verify] ghost button.
  - Clicking either cell opens the transcript.
- **Emblem (120, 160 or 200px; landing verifier, receipt hero, share PNG).** SVG with viewBox 0 0 200 200, centered at (100,100):
  - **Rim:** circles r 98 (--line-strong 1px) and r 92 (--line 1px). Between them a guilloche path ρ(θ) = 95 + 2·sin(36θ), sampled at 360 points, in --text-3, 0.5px, opacity .6.
  - **Hex ring:** a `<textPath>` on a circle of r 84 starting at 12 o'clock, mono 7.5 (viewBox units), --text-3, `textLength≈520`, `lengthAdjust="spacing"`. Content: `TRANSACT · #263104 · <proof hex…>` cut to fit, like a coin's reeded edge.
  - **Dual band at r 72:** two 160° arcs with 20° gaps centered at 12 and 6 o'clock. The left arc is --btc, the right arc --proof.
    - Outline state: stroke 1.5 (dashed 3 3 for mempool or awaiting).
    - Solid state: stroke 6. Round caps.
  - **12 o'clock gap:** a 4px --btc dot (the sealed root).
  - **6 o'clock gap:** a 14px status disc: ✓ on --proof with --proof-ink, ✗ on --danger, or "…" on --line.
  - **Plate:** r 64, --surface-1 fill, --line 1px.
  - **Center:** the Proofprint (§6.9) at outer radius 56.
  - The emblem is always followed by the Block variant, so all state text is in HTML.
- **Stamp motion:** played once, when the state becomes "browser verified". Band stroke-dashoffset draws over 500ms, scale goes .97→1, and the status disc fades in. With reduced motion, the final state shows immediately.

### 6.3 Root Match chip (top bar)
- **Shape:** 28px pill, mono 11.
- **States:**
  - checking: --line-strong, a 10px spinner, "Root…";
  - match: --proof-wash fill, --proof-line border, "✓ Root 1a2b…9f8e" plus `IDX` with the rebuild tip (the indexer's list and its root agree; only Verify the Pool checks them against Bitcoin);
  - indexer-only: --line-strong border, "Root 1a2b…9f8e" plus `IDX`;
  - mismatch: --danger-wash fill, --danger-line border, "✗ Root mismatch". All chain-writing buttons are disabled, with the reason line "Root mismatch: switch indexer or sync again".
- **Popover** (320px; on phones a sheet): eyebrow "ROOT MATCH", then "Your browser rebuilt the note tree from the 1,284 commitments our indexer served and got the root it reports at #263,104: its list and its root agree. Only Verify the Pool checks them against Bitcoin." Below that, a mini table: indexer root, local root, commitments, time (ms). Buttons: [Rebuild now] [Use your own indexer…] (to /verify#indexer, no wallet needed). Keyboard: focus moves to [Rebuild now] on open and back to the chip on Esc; Tab past either end closes it. Menus (theme, wallet) also take arrow keys, Home and End.
- **Public pages without a wallet:** after first paint, on idle, if outputs ≤ 10,000, rebuild in a Web Worker so the chip shows the match (still `IDX`, with the rebuild tip) within about 2 s of landing, or catches a root mismatch. The chip never claims more than that: a match proves consistency, not Bitcoin.

### 6.4 Verification Transcript and the verifier engine
**Engine:** `web/src/verify/engine.js` emits row events; the UI renders them live.
- Raw data comes straight from mempool.space (`https://mempool.space/signet/api`), never from us:
  - `/tx/:txid/hex`
  - `/tx/:txid/status`
  - `/tx/:txid/merkle-proof`
  - `/block/:hash/header`
  - prevout txs for MINT_SCRIPT.
- snarkjs is lazy-loaded on click, and prefetched when the panel enters the viewport.

**Rows for TRANSACT.** Each row is: status glyph · chip · label · mono detail · real ms.
1. `BTC` **Raw transaction fetched.** "mempool.space/signet/api/tx/9fc2…/hex · 612 vB". Show the exact URL.
2. `BTC` **Mined** in #263,104 with 3 confirmations, or "In mempool". In mempool, rows 3 and 10 are skipped.
3. `BTC` **Included in block.** The merkle path (N hashes) rebuilds the header's merkle root, and the header hash meets its own difficulty target. The popover notes that the header chain isn't checked.
4. `YOU` **Envelope found** in the first matching OP_RETURN and decoded strictly: "TRANSACT · 471 bytes · anchor #263,050".
5. `YOU` **Binding hash recomputed** from the envelope bytes: "extDataHash 0x1f3a…9c". Uses `src/envelope.mjs`.
6. `YOU` **Proof points valid:** canonical, on curve, G2 subgroup, not infinity. Uses `src/proof-codec.mjs`.
7. `YOU` **Verification key** sha256 "a3f1…9c2e" matches the fingerprint pinned in this build and published on /security and in the README.
8. `IDX` or `YOU` **Anchor root** at #263,050. Best source first: your own replay (Verify the Pool), when it covers the anchor and its block there is still the chain's, gives `YOU`. Otherwise the Worker rebuild from the indexer's commitments (outputs with height ≤ anchor), compared with the indexer's roots read in fixed 2000-height pages (`/api/roots?from&to`, never a request for the anchor height alone); a match stays `IDX` with the rebuild tip (detail: "rebuilt from 1,180 commitments served by our indexer · matches its root (only a replay checks them against Bitcoin)"), and a mismatch fails as `YOU` with "Do not trust this indexer". Without a rebuild, the indexer's reported root, `IDX`. A proof that fails only against an `IDX` root is inconclusive ("Doesn't verify against the indexer's root", with a link to Verify the Pool), never "Proof failed".
9. `YOU` **Groth16 pairing check:** "valid · 9 ms".
10. `IDX` **Nullifiers unspent before this transaction; indexer verdict accepted at #263,104.** From the whole log, read in pages (`/api/log?from=`) and filtered in the browser; no request names the txid.

**MINT and MINT_SCRIPT** add, after row 6:
- `BTC` "Treasury paid 1,000 sats in this transaction", computed from the raw tx outputs;
- `BTC` "First input is the bound coin" (MINT), or "spends the bound address", using the prevout tx (MINT_SCRIPT);
- `IDX` "Within cap and mint window".

**DEPLOY:** rows 1–4, then `YOU` "Terms valid", then `IDX` "First valid deploy of this ticker".

**Footer** (mono 11 --text-3): "7 of 10 checks ran in your browser · 2 rely on Bitcoin data from mempool.space · 1 relies on our indexer". Buttons: [Copy transcript] [Re-run]. Source line: "Data: mempool.space/signet, independent of us."

**Row style:**
- Grid columns: 16px glyph | 44px chip | 1fr label/detail | auto ms. Min height 32.
- Label: sans 13. Detail: mono 12 --text-2, wrapping anywhere.
- Glyphs: ○ pending (--text-3), a 12px spinner, ✓ in --proof-text, ✗ in --danger, – skipped.
- A failed row expands its detail in --danger. Rows after a failure are marked skipped.
- Container: --surface-inset, radius 10, padding 12, `aria-live="polite"`.
- There is never a fake success.

### 6.5 Envelope Anatomy `.hexmap`
- **Grid:** a byte grid using container queries:
  - 32 columns when the container is 640px or wider;
  - 16 at 420px or wider;
  - 12 otherwise;
  - 8 under 300px.
- **Cells:** square, mono 10 (lowercase hex), gap 2.
  - Fill: `color-mix(in srgb,var(--f-x) 16%,transparent)`; text in `var(--f-x)`.
  - Ciphertext cells: --redact with --hatch, text --text-3 at 60%. The bytes are public but unreadable.
- **Fields:**
  - header (magic, version, op) → f-header;
  - h_anchor → f-anchor;
  - publicAsset and publicAmount → f-public;
  - bindOutpoint or bindScriptHash → f-bind;
  - nullifiers → f-nullifier;
  - commitments → f-commitment;
  - noteCiphertext → f-cipher;
  - proof → f-proof.
- **Legend:** chips in the same colors. Hovering or tapping a field dims the others to 35% and shows a legend line. Examples:
  - "nullifier[0] · 32 bytes · public spend tag: shows that some note was spent, not which one"
  - "encrypted note[1] · 95 bytes · only the recipient's view key opens it"
- **Summary row:** "TRANSACT · 471 bytes · carried in a 612 vB transaction".

### 6.6 Disclosure Preview: "What becomes public" (mandatory before every chain-writing action)
A two-column certified panel (stacks on phones).

| Op | PUBLIC ON BITCOIN | HIDDEN BY PROOF |
|---|---|---|
| Send | Operation (private transfer), envelope 471 bytes, Bitcoin fee "~1,240 sats (6 sat/vB)", paid by (payer address, "Whoever carries the envelope" for a copied envelope, or "Relayer, shared address" for a send relayed from a relay balance), time | Token, amount, sender, recipient, which notes you spent |
| Mint | Operation (mint), token, amount, "1,000 sats to treasury", paid by your Bitcoin address, fee | Which shielded address receives the note, and what you do with it next |
| Launch | Everything: ticker, terms, treasury, deployer address. "A launch is public by design: everyone must be able to check the terms." | Nothing |

**Linkability row** (under the payer choice): a 3-segment meter (24×4px each) plus one sentence. The approved sentences are `LINK_TEXT` in `web/src/ui/meter.js`:
- **Relayer** (shown when the send is relayed from a prepaid relay balance, `docs/design/relay-balance.md`): 3/3 --proof. "On Bitcoin, relayer coins carry the transfer, not yours. The relayer knows which balance paid and the address you topped up from. It can't read or change the contents: the proof binds every byte."
- **Built-in key:** 2/3 --warn. "Every transfer paid by this key shares one Bitcoin address."
- **Unisat:** 1/3 --danger text. "Linked to your Unisat address tb1q…7k on Bitcoin."
- **Mint:** "Mints are always paid from a Bitcoin address, so this mint is linked to it. Later private transfers aren't, unless that address pays their fees too."

### 6.7 Redaction `.redact`
- **Bar:** inline-block, height 1em, radius 3, --redact plus --hatch, with a 9px lock glyph at the start.
- **Widths:** amount 7ch, token 5ch, address 14ch.
- **Text:** `aria-label="Hidden by zero-knowledge proof"`. Tooltip per field. Token, amount, recipient: "Not readable on Bitcoin. Only the sender and recipient can see it." Sender: "Hidden by the proof. Only the sender knows it; the recipient doesn't learn it either." Spent notes: "Hidden by the proof. Only the sender knows which notes were spent." (The note plaintext carries only token, amount and blinding.)
- **Observer view / My view toggle** (segmented control) where you own the transaction. Real values get a 1px dashed --line-strong outline plus a caption:
  - received notes: "decrypted in this browser";
  - sent transfers: "from your history on this device".
- **"Hide amounts"** on the portfolio swaps your amounts for bars (for streaming and screenshots).
- Hidden values are never shown as "***".

### 6.8 Anonymity-set meter
- **Copy:** "Your next transfer hides among 1,284 notes in one pool shared by 7 tokens."
- **Bar:** a 4px bar on a log scale from 1 to 10⁶ with ticks at 10, 100, 1k, 10k and 100k. Fill is --text-2; the number is mono; chip IDX, or YOU after a rebuild.
- **Tooltip:** "Timing, the fee payer and unusual amounts can still narrow this down. Send with the relayer, and don't send right after you receive."

### 6.9 Proofprint (deterministic guilloche from proof bytes)
- **Input:** bytes b[0..31] of the compressed proof.
- **Parameters:**
  - n (petals) = 5 + b0 % 9;
  - L (lines) = 8 + b1 % 9;
  - inner = 0.35 + (b2/255)·0.35;
  - φ = b3/255·2π;
  - twist = 0.15 + (b4/255)·0.6.
- **Lines:** for k in 0..L−1, ρk(θ) = R·(inner + (1−inner)·(0.5 + 0.5·sin(n·θ + φ + k·twist·2π/(n·L)))), sampled at 144 points (θ step 2.5°) as a closed path, 0.6px stroke, --text-3, opacity .7.
- **Accent strokes:** line 0 in --btc once the transaction is mined; line L−1 in --proof once the browser has verified it.
- **Sizes:** 24px in activity rows (draw only L/2 lines), 112px in the emblem plate, 200px on the receipt.
- **Tooltip:** "Visual fingerprint of the proof bytes. Not a security check; use Verify."

### 6.10 Token sigil
- **Input:** h = sha256(utf8(assetId decimal)).
- **Pattern:** a 5×5 mirrored grid. 15 cells (3 columns × 5 rows) come from the bits of h[0..1]; force at least 5 cells on.
- **Color:** `--sg-(1 + h[2] % 6)` cells on a --surface-3 tile with radius 28% and a 1px --line border.
- **Sizes:** 32, 40, 56 and 96px.
- No uploads and no image hosting; every token gets a logo.

## 7. Standard components

- **Panel.** --surface-1, 1px --line, radius 10, padding 20 (16 on phones), --shadow-1. The header row holds a mono eyebrow, an h3 and right-aligned actions.
  - The **certified** modifier (receipts, seal, verifier, lock screen) adds 8px L-shaped corner registration ticks in --line-strong.
- **Stat tile.** Eyebrow, hero-number mono, footnote caption --text-3, and a provenance chip top-right. No icons; no count-up in the app.
- **Tables.**
  - 44px rows, a sticky header in eyebrow style, right-aligned mono numbers.
  - Hash cells have copy and verify icons that show on hover (always visible on touch).
  - Under 720px each row becomes a stacked card: a 2-column dl with the seal pill top-right.
  - Paging is "Load older", never numbered pages.
- **Buttons.**
  - Heights 32 (compact), 40 (default) and 48 (phone primary: full width, sticky in the form footer with safe-area padding). Radius 8, sans 500 15, padding 0 16.
  - **Bitcoin primary:** --btc fill with --btc-ink text; hover --btc-hover; press --btc-press. Used **only** for the final action that triggers signing. The label states the cost: "Mint · 1,000 sats + fee", "Send privately", "Launch token · ~1,100 sats".
  - **Neutral primary:** --inverse fill, --inverse-ink text; hover --inverse-hover. For Open wallet, Unlock, Continue and Verify in my browser.
  - **Secondary:** --surface-2 with a 1px --line-strong border.
  - **Ghost:** text only.
  - **Danger:** --danger outline.
  - **Icon button:** 40×40.
  - Press: 120ms darken. Loading: an inline 14px ring plus a live label ("Proving… 0.8 s").
  - Disabled: 40% opacity **plus a reason line** below in caption --text-3, e.g. "Top up 1,240 sats". Never silently disabled.
- **Forms.**
  - Label: sans 500 13 above the field. Help: caption --text-3 below. Error: caption --danger with an icon.
  - Inputs: 44px (48 on phones, 16px text), --surface-2, 1px --line-strong border, radius 8, 2px --focus ring at 2px offset.
  - Addresses and amounts are mono, with inline suffixes (ticker, "sats") and "Paste" and "Max" chips.
  - The mrk1 field validates the checksum live: ✓ "Valid shielded address" in --proof-text, or "Checksum failed" in --danger.
  - The amount line under the field reads "Available 1,250.00 ABC · Max".
- **Segmented control.** A --surface-2 track, radius 8, padding 3. The active thumb is --surface-3 with a --line-strong border, animated over 180ms. It becomes a `<select>` under 360px.
- **Fee payer radio cards.** Relayer / Built-in key / Unisat. Each card shows the name, status (online, balance or connect), the fee, and its linkability sentence plus meter.
  - On Send, Relayer is preselected when it is online.
  - On Mint, the Relayer card is disabled with the reason "Mints are paid from your Bitcoin address".
  - On signet, the Unisat card shows the relay-policy warning.
- **Modals and sheets.**
  - Desktop: centered, max 520px, radius 14, --shadow-pop, --scrim.
  - Phone: bottom sheets with a grabber, max-height 90dvh, inner scroll and safe-area padding.
  - Esc and scrim click close every sheet except signing, proving and broadcast.
- **Proving sheet.** A determinate stepper driven by the real `onStep` callbacks. Each step has a mono elapsed time.
  1. Load proving key (cached / 12.3 MB)
  2. Sync pool and match root `YOU`
  3. Select notes
  4. Build witness
  5. Prove (Groth16, {facts.constraints} constraints). Uses a 2px indeterminate bar plus a live timer; the proof hex streams into an inset well when done.
  6. Self-verify proof locally `YOU`
  7. Sign: "Confirm in Unisat", "Signing with built-in key" or "Handing to relayer"
  8. Broadcast, then In mempool `BTC`

  It ends on the Dual Seal pill in the mempool state, with [View receipt] and [Done].
- **Toasts.**
  - Position: desktop top-right, 380px wide; phone bottom-center above the tab bar, width calc(100% − 32px).
  - At most 3. Kinds: info, success, warn and danger, each with a 3px left rail in the role color, a title, one sentence and an optional action ("View receipt").
  - Info and success dismiss after 7 s; danger stays until closed.
- **Empty states.** A line-art merkle branch with hollow leaves (120px, --text-3), one sentence and one action:
  - Portfolio: "No notes yet. Mint from an open token to receive your first private note." [Browse mints]
  - Activity: "No proofs yet. Your first receipt will appear here."
  - Mints: "No open mints right now. Be first: write a token to Bitcoin." [Launch a token]
  - Rejected filter: "Nothing rejected. Every envelope followed the rules."
- **Skeletons.** --surface-2 blocks with no shimmer (the only loop in the product is the synced dot).
- **Icons.** An inline SVG sprite (`ui/icons.js`), 20px grid, 1.5px stroke, round joins. Set: seal, root, nullifier (a tag with a slash), commitment (a sealed envelope), proof (a check in a hexagon), block (cube), lock, unlock, relayer (a broken link), copy, external, qr, send, mint, launch, search, server, eye, eye-off, shuffle, sun, moon, chevron, check, cross, warn. No emoji anywhere.
- **QR.** Generated locally (a small zero-dependency npm lib such as `uqr`, or hand-rolled). Always dark on a white tile.

## 8. Motion

| Motion | Spec |
|---|---|
| Easing | `--ease cubic-bezier(.2,.7,.2,1)` |
| Hover / press | 120ms |
| Popovers, tabs, segmented controls | 180ms |
| Sheets and modals | 240ms; translateY 16px plus fade |
| Chip upgrade IDX→YOU | 300ms crossfade |
| Seal stamp | 500ms, once per verification |
| Page change | main fades in with a 6px rise over 160ms |
| Number updates | 160ms crossfade |

- **Transcript:** rows appear when their promise resolves, with a minimum 60ms stagger for legibility. No artificial delay; all timings are measured.
- **Proving:** only step 5 is indeterminate. The elapsed timer ticks every 100ms.
- **Loops:** exactly one, the synced dot (2.4s opacity pulse, paused when `document.hidden`).
- **Landing:** stats count up once on first view, to real values only.
- **Lattice:** new leaves flash --btc for 1.2s, then settle to --text-3.
- **Never:** confetti, particles, parallax, glow, gradient sweeps, shimmer, 3D, shake.
- **`prefers-reduced-motion: reduce`:** every transform goes to 0ms, with at most an 80ms opacity fade. The seal shows its final state, the lattice is static, and the transcript renders all at once (still live as results arrive). No information is carried by motion alone.

**Merkle lattice (landing hero and receipt hero):**
- One SVG behind the content. A binary tree of depth 6 rooted at the left middle, fanning out to 64 leaves at the right edge, in 1px --bg-lattice lines.
- Leaves map to `leafIndex mod 64` of the newest window: occupied leaves are filled --text-3 dots; empty ones are hollow.
- On a poll of `/api/state` (every 20 s) with new outputs, those leaves flash --btc.
- Phone: depth 5 at 60% opacity.

## 9. Pages and routing

**Routing:**
- A History-API router (`web/src/router.js`, about 60 lines) that intercepts `a[data-link]` and restores scroll.
- Server: `server/indexer-server.mjs` serves `web/dist/index.html` for any GET outside `/api` and `/artifacts` that matches no file. Vite handles it in dev (appType "spa").
- Priorities: **P0** = this session, P1 = next, P2 = later.

**Public pages:**
- **`/` Landing (P0).** See §10.
- **`/mints` Mint board (P1; P0 can be a simplified version).**
  - Header: H1 "Mints", lead "Open-mint tokens on Bitcoin. Terms are public; holders are not.", and [Launch a token] (secondary).
  - Filters: Open · Upcoming · Minted out · All. Sort: Trending (mints in the last 144 blocks) · Newest · Closing soon · Cheapest. Ticker search.
  - Grid of **launch cards**:
    - Row 1: 40px sigil, ticker, and a status pill:
      - OPEN: --btc-wash fill, --btc-line border, static dot;
      - "OPENS IN 37 BLOCKS": neutral outline;
      - MINTED OUT: hatched neutral;
      - ENDED: --text-3.
    - Row 2: mono 12 "Launched #262,880 · 4ef1…a09c".
    - Row 3: progress track (4px, --btc fill, ticks at 25/50/75%; a sold-out track is hatched) with "412 / 1,000 mints · 41%".
    - Row 4: dl with Per mint, Price (sats in --btc-text) and Supply.
    - Footer: [Mint · 1,000 sats + fee] (Bitcoin primary when the wallet is ready; otherwise neutral, routing to `/app/mint?t=ABC`) or a reason line.
    - Hover: border goes to --line-strong. No lift.
  - No holder counts anywhere, by design.
- **`/t/:TICKER` Token page (P1).**
  - Hero (2 columns on desktop): a 96px sigil, the ticker (sans 700 clamp 32–48), a status pill, an 8px progress bar with numbers, and "Mint for 1,000 sats". The CTA is sticky at the bottom on phones.
  - Right column: a **"Terms on Bitcoin"** certified panel.
    - It contains the deploy's Dual Seal block and a dl: per mint, cap, total supply, price, treasury (chunked), start and end blocks with ETA ("Opens in 37 blocks, about 6 h"), and decimals, each with a `BTC` chip.
    - Caption: "Written in block #262,880. Immutable." Link: deploy receipt.
  - "Live mints" feed: block, tx, "+1,000 ABC → [redact]", seal pill.
  - "Mints per block" mini chart: the last 144 blocks as 2px --btc bars on a hairline axis.
  - **Holders panel:** redaction-bar art with "No holder list. No whale alerts. That's the feature." and "Supply minted: 412 × 1,000 = 412,000 · publicly checkable `IDX`".
  - **Launch kit:**
    - Copy link.
    - Download announcement card: a 1200×675 PNG from canvas, observer data only.
    - "Share on X": an intent link with "Mint $ABC on Bitcoin (signet test network, no value). Terms on-chain; transfers are private, mints are public. {url}". The text leaves the site, so it carries the signet note and never says a mint is private.
    - Embed code (P2).
- **`/explorer` (P1).**
  - Stat tiles (auto-fit, min 160px): Bitcoin height `BTC`, Pool root `YOU/IDX`, Notes `IDX→YOU`, Spent nullifiers `IDX`, Tokens `IDX`, Envelopes accepted / rejected `IDX`.
  - **Block strip:** the last 24 blocks (12 on tablet, 8 on phones) as 16px squares with 4px gaps. Empty blocks are --line outlines; blocks with protocol operations are filled --btc with a count. Hovering or tapping lists the operations.
  - **Operations feed:** columns Block · Op badge · Tx · Public data · Seal.
    - Op badges are 1px outlines: DEPLOY (--btc-line), MINT (--btc-line), TRANSFER (--line-strong plus a lock glyph). Note the UI says TRANSFER for op TRANSACT.
    - Public data: transfers show three redaction bars; mints show "+1,000 ABC → [redact]"; deploys show a terms summary.
    - Rejected rows show the reason.
    - Filters: All, Launches, Mints, Transfers, Rejected.
  - Root history: the last 20 R[H], each with a "matches local rebuild" chip.
- **`/block/:height` (P2).** The block's operations, the root after the block with its chip, and a mempool.space link.
- **`/tx/:txid` Proof Receipt (P0; the flagship share page).**
  - **Hero** (certified panel with lattice):
    - eyebrow "PROOF RECEIPT · TRANSFER";
    - a serif headline driven by state: "Checking proof…", "Proof verified.", "Accepted by indexer.", "In the mempool." or "Proof failed.";
    - sub: "Private transfer mined in #263,104. Verified in this browser in 412 ms.";
    - the emblem (200px, right on desktop; 120px centered above on phones) and the Dual Seal block;
    - actions: [Re-run] [Copy link] [Share image] [mempool.space ↗].
  - Verification **auto-runs** on open.
  - Then, in order:
    1. Transcript.
    2. Envelope Anatomy.
    3. "What this transaction reveals": the Public vs Hidden columns, with the Observer/My view toggle when the unlocked wallet owns notes here.
    4. Public inputs: anchor height and root ("N blocks before inclusion · window 100"), extDataHash, nullifiers linking to /nullifier/, commitments with leaf index linking to /commitment/.
    5. Bitcoin: fee, vsize, fee rate, position, confirmations, and the payer address with the note "This is the only identity this transaction reveals".
    6. "Indexer vs your browser": "They agree" `YOU` when your own replay also judged the transaction (history rules included); otherwise "Agrees on every rule your browser checked" `YOU` plus a line naming the history rules (spent notes, mint cap, a free ticker) that rest on the indexer's log `IDX`; or the danger seal.
  - **Share image:** a 1200×630 canvas PNG, always the observer view. It contains the lattice, emblem, op badge, sigil or redaction bars, block, short txid, "Proof on Bitcoin. Verified in the browser.", the wordmark and a "signet" tag. Warning before sharing: "A receipt hides amounts, but sharing it tells people this transaction is yours."
  - The URL contains only the txid.
- **`/nullifier/:hex` and `/commitment/:hex` (P1).** One lookup template that answers Spent/Unspent or Included, with the transaction, leaf index and seal pill.
- **`/verify` (P0 for A and C; P2 for B).**
  - A) Paste a txid, nullifier or commitment and run the same engine as the receipt.
  - B) "Audit the whole pool" in a Worker: fetch every logged protocol tx from mempool.space, check inclusion, replay the indexer rules, rebuild roots per block and verify every proof. Result seal: "Your browser replayed N transactions from Bitcoin and got the same root." Caveat: "Detects a wrong state, not an omitted transaction."
  - C) Artifact fingerprints (vkey, zkey, wasm) with sizes and sha256, recomputed locally and compared with facts.json (YOU chip on a match).
  - D) Run your own indexer: copyable commands.
  - E) Switch indexer (`#indexer`, no wallet needed): URL field, [Test connection] (compares roots at the lower of the two heights), [Use this indexer], [Back to this site's indexer]. Switching refreshes the chain state now and resyncs an unlocked wallet.
  - The "On this page" nav links all five.
- **`/security` (P0).**
  - The status board (§10.8).
  - A findings table, A-1…A-9, with severity and status chips (Medium in --warn, Low and Info neutral; Fixed in --proof-text, Documented neutral).
  - Methodology: circomspect, Picus + cvc5 and tests, with what each does **not** prove.
  - Trusted setup status ("single-party development setup", a --danger outline tag) plus an MPC ceremony placeholder.
  - The mainnet checklist and a responsible-disclosure contact.
- **`/protocol` (P1).** SPEC.md (translated to English), rendered from `SPEC.md?raw` by a minimal in-repo markdown renderer (headings, tables, lists, code) so docs never drift. Includes inline anatomy diagrams.
- **`/pay#to=mrk1…&t=ABC&a=250` (P1).** The fragment is parsed client-side and never reaches the server. Card: "Someone requests 250 ABC" with a chunked address. [Pay privately] opens /app/send prefilled; without a wallet it offers Create or Import first.
- **404.** "Nothing at this path. Bitcoin never forgets, but this page never existed." plus search.
- **Global search** (resolved locally):
  - 64-hex → txid, nullifier or commitment, in that order;
  - ticker → /t/;
  - mrk1… → the inline message "Shielded addresses never appear on Bitcoin, so there's nothing to look up." The address is never sent anywhere.
- **`/embed/t/:TICKER` (P2).** A 360×200 mint-progress widget for launchers' sites (once this view exists, framing may be allowed on this exact route only; until then it is denied like every other route).

**Wallet pages** (`/app`; keys stay on the device):
- **`/app` gate (P0).**
  - No vault: onboarding with two cards, [Create new wallet] (neutral primary) and [I have a phrase].
  - Vault present: the **lock screen**, a centered certified panel with the glyph, "Wallet locked", a password field (48px), [Unlock], and "Forgot password? Restore from your 24 words".
  - A legacy plaintext `zkpool.signet.phrase` triggers a forced sheet, "Protect your wallet with a password". It creates the vault, seals the history, then deletes the plaintext copies.
- **`/app/create` (P0):** a 4-step stepper.
  1. **Password + confirm.** A 4-segment hairline strength meter; minimum 8 characters. Copy: "Your recovery phrase is encrypted on this device with XChaCha20-Poly1305. The key comes from your password via scrypt (N = 65,536, r = 8, p = 1, about 64 MiB), so guessing is slow. We never see either." The parameters come from `KDF`.
  2. **24 words** in a 3-column grid (2 on phones), mono, blurred until press-and-hold. Copy warns "Anyone with these words owns your notes."
  3. **Confirm 3 random words.**
  4. **Done:** the seal stamp, "Wallet encrypted on this device".
- **`/app/import` (P0).** Textarea with live BIP-39 validation ("24 valid words ✓") plus a new password.
- **`/app` Portfolio (P0).**
  - Wallet state line: "Indexer consistent: root matches at #263,104" `IDX` with the rebuild tip, and the caption "Your browser rebuilt the note tree from the commitments our indexer served and got the root it reports. Verify the Pool checks them against Bitcoin."
  - Private balances table: sigil, ticker, balance, available (with an amber "pending" sub-line).
  - "Hide amounts" toggle.
  - Shielded address card: chunked mrk1 with a QR tile and copy, and "This address never appears on Bitcoin."
  - Anonymity meter; fee payer summary with its linkability meter; quick actions Send · Receive · Mint.
- **`/app/receive` (P1).** Large address and QR. "Request a payment" builder (token and amount) produces a `/pay#…` link plus QR, with the note "Payment details stay after the #, so they never reach our server."
- **`/app/send` (P0).**
  - Asset picker (sigil, ticker, available) → amount with Max → recipient (paste, live checksum, prefill from /pay) → fee payer cards → Disclosure Preview → [Send privately] (Bitcoin primary) → proving sheet → receipt.
- **`/app/mint` (P0).** The mint board filtered to "mintable now". Each card shows the cost in sats and payer readiness ("Connect a fee payer", or "Top up 1,240 sats" with a faucet link) → Disclosure Preview → proving sheet.
- **`/app/launch` (P1; P0 can restyle the existing form).**
  - Form groups: Identity (ticker with a live availability check, decimals), Supply (per mint × mints = total), Price and treasury (prefilled from the payer), Schedule (start and end with ETAs).
  - Live preview: the exact mint-board card, total supply, max raise in sats, and the DEPLOY envelope as Envelope Anatomy with its byte size and estimated fee.
  - Review sheet: "Tickers are first come, first served. Terms can't change after this transaction." Then [Launch token · ~N sats].
  - After success: "Share /t/ABC with your community" plus the launch kit.
- **`/app/activity` (P0).** Rows: Proofprint 24px, kind, amount (your view), counterparty short form, seal pill, time. Statuses: In mempool / Waiting for indexer / Accepted / Rejected (reason) / Dropped. Filters: All, Sent, Received, Minted, Launched, Failed. Tapping opens `/tx/:txid` in My view.
- **`/app/notes` (P2).** Note inspector: leaf index, commitment, asset, amount, block, spent. "Show merkle path" draws the 32-level path to the root and checks it locally.
- **`/app/settings` (P0).**
  - Security: change password, auto-lock (5 / 15 / 60 min / never; default 15), Lock now, reveal phrase (password required). Lock now locks every open tab of the wallet; the idle auto-lock stays per tab.
  - Fee payer default: Relayer · Built-in key (address, balance, faucet) · Unisat (connect), each with its linkability text.
  - Indexer URL ("Use your own indexer", with a connection test and root comparison).
  - Appearance.
  - Danger zone: "Remove wallet from this browser" (type REMOVE to confirm).

## 10. Landing page copy (English, final)

**Meta:**
- `<title>Murkle · Private tokens on Bitcoin</title>`
- description: "Launch and mint tokens on Bitcoin L1 in public, then send them privately. Proofs are written to Bitcoin and verified in your browser. Signet testnet."
- A static og.png (1200×630): graphite, emblem, H1.

**1. Hero** (two columns on desktop: copy 6 columns, Live Verifier 6 columns; stacked on phones; lattice behind)
- Eyebrow chip (live height): "LIVE ON BITCOIN SIGNET · BLOCK #263,104"
- H1 (serif): "Private tokens on Bitcoin." / "Proven, *not promised*."
- Lead: "Launch and mint tokens on Bitcoin L1 in public, then send them with the token, the amount and the recipient hidden by zero-knowledge proofs. Every proof is written into a Bitcoin transaction, so anyone can check it. This page does, in your browser, from raw Bitcoin data."
- CTAs: [Open wallet] (neutral primary) and [Verify a live proof] (secondary; on desktop it focuses the verifier, on phones it scrolls to it). Text link: "Read the security status →".
- Microline (caption): "No sign-up. Keys never leave your device. Test coins only."

**2. Live Verifier** (certified panel)
- Eyebrow: "LIVE VERIFIER". Selector: "Latest private transfer · #263,104 · 4 min ago" [Shuffle], drawn from the last 50 accepted proof-carrying transactions.
- Envelope Anatomy (compact), then the row "Token ▒ · Amount ▒ · Sender ▒ · Recipient ▒ · Proof 128 bytes · Fee 1,204 sats".
- [Verify in my browser] (neutral primary, full width).
- The transcript streams (§6.4), then the emblem stamps.
- Result: "Verified in your browser in 412 ms. Bitcoin carried the proof; your machine checked it."
- Then: [Open receipt] [Try another] and a "Verify any txid…" field.
- Small print: "This widget calls mempool.space directly from your browser. Open your network tab and watch. Bitcoin stores and orders this data; it doesn't run the proof. The rules are enforced by replay, as with Runes and Ordinals, which is why anyone can re-check them."

**3. Live stats strip** (mono, chips, one count-up)
- "BLOCK #263,104 `BTC` · 1,284 NOTES IN THE POOL `YOU` · 312 PROOFS ON BITCOIN `IDX` · 7 TOKENS `IDX` · 4,120 MINTS `IDX`"

**4. "What Bitcoin sees."**
- Segmented control: Normal token transfer | Private · what everyone sees | Private · what you see. Explorer-style card rows: Token / Amount / From / To / Proof.
  - Normal: "SAMPLE•TOKEN · 50,000 · bc1q…8f2k · bc1q…r7m0 · none".
  - Private, public view: four redaction bars and "128 bytes · valid".
  - Private, your view: "ABC · 250 · you · mrk1q…w4f9 · decrypted in this browser".
- Caption: "Both are ordinary Bitcoin transactions. Only one tells the world your bag." Footnote: "The token is hidden too: every token shares one pool."

**5. "Four steps, all on Bitcoin."** (numbered 01–04, joined by a hairline)
- **01 Launch:** "Write a token's terms to Bitcoin: ticker, supply, mint price, schedule. One transaction. No premine. Terms can't change."
- **02 Mint:** "Anyone mints by paying sats to the treasury in the same transaction. The tokens arrive as a private note only you can open. Each mint is bound to your own coins, so copies from the mempool get nothing."
- **03 Send:** "Your browser builds a zero-knowledge proof in about a second. Bitcoin carries a 471-byte envelope; the token, amount and recipient stay hidden."
- **04 Verify:** "Any indexer replays the chain and gets the same pool root. Your wallet checks it, and anyone can re-verify any proof from raw Bitcoin data."

**6. "One pool. Every token."**
- Big mono counter: "1,284 notes · 7 tokens · 312 spent".
- Copy: "A transfer of any token looks exactly like a transfer of every other token. Every new launch makes the crowd bigger for all of them."
- Caveat chip (warn outline): "Timing and fee payers can still leak. Send with the relayer."

**7. "Fair launches. Private holders."**
- Lead: "Runes-style open mints, with one difference: nobody can read the holder list, because there isn't one."
- Bullets:
  - "Open mint, paid in sats. No premine."
  - "The treasury is paid in the same Bitcoin transaction."
  - "Supply is public and checkable. Holders are not."
  - "Mints are bound to the minter's coins, so mempool copycats get nothing."
  - "No whale alerts. No copy-trading your buyers."
- Three live launch cards (two on phones). [Browse mints] [Launch a token].

**8. "Don't trust. Verify."** (three columns)
- **Bitcoin guarantees** (--btc-text header):
  - "The envelope bytes are in a block."
  - "Their order and time."
  - "The mint payment is in the same transaction."
- **Your browser checks** (--proof-text header):
  - "The Groth16 proof against the published key."
  - "The hash binding the proof to these exact bytes."
  - "Valid curve and subgroup points."
  - "The pool root, rebuilt from every commitment."
  - "Which notes are yours, by local trial decryption. The server never learns."
- **Still trusted on signet** (warn header, hatched):
  - "Proving keys from a single-party development setup."
  - "Block data from a public API, not yet our own Bitcoin node."
  - "Our transaction list: your browser catches a wrong state, not a hidden transaction. Run your own indexer to close that gap."
- Row underneath: "Before mainnet: multi-party setup ceremony, external audit, our own Bitcoin node."
- Tool tiles:
  - "Your wallet rebuilds the note tree and checks the root" (live Root Match);
  - "Re-verify any proof from raw Bitcoin data" (a txid field → /tx/);
  - "Run your own indexer" (snippet `npm install && npm run indexer` after downloading the pinned keys, full steps on /verify#run; the clone line only once a public repo exists), then "switch this site to it" (/verify#indexer, no wallet needed).

**9. "Security status."** (board; chips DONE / SIGNET ONLY / BEFORE MAINNET / BY DESIGN)
- "Circuit: {constraints} constraints, Groth16 on BN254, 2-in/2-out, depth-32 Poseidon tree" DONE.
- "Formal under-constraint check (Picus + cvc5): no under-constrained signals except harmless IsZero helper inverses, explained in the report" DONE.
- "Static analysis (circomspect): 25 notes, 0 real issues" DONE.
- "Internal review: 9 findings, 2 medium, both fixed with regression tests" DONE.
- "{testCount} automated tests" DONE.
- "Trusted setup: single-party development setup" SIGNET ONLY → "MPC ceremony" BEFORE MAINNET.
- "Block headers from a public API" SIGNET ONLY.
- "Note encryption isn't proven in the circuit; a bad sender can only hurt their own payment's recipient" BY DESIGN.
- "External audit" BEFORE MAINNET.
- Caption: "Internal review, not an independent audit yet." [Read the full report →]

**10. "Built for launches. Designed for privacy."** (six tiles)
- **Proof receipts:** "Every transaction gets a page anyone can re-verify. Share it as an image."
- **Private payment links:** "Request tokens with a link. The details live after the #, so they never reach our server."
- **Launch kit:** "A token page, an announcement card for X and a mint widget for your site."
- **Fee relayer:** "Send without touching your Bitcoin wallet, so your transfers aren't linked to your addresses."
- **Password lock:** "Your recovery phrase is encrypted on this device and locks itself when idle."
- **Pool audit:** "Replay every private transaction from Bitcoin in your browser and match the pool root."

**11. FAQ** (accordion)
- **Is this a bridge or a sidechain?** "Neither. It's a metaprotocol, like Runes: the data lives in ordinary Bitcoin transactions and the state comes from replaying blocks. Tokens are born inside the protocol; no BTC is locked anywhere."
- **Does Bitcoin itself verify the proofs?** "No. Bitcoin stores and orders them. Verification is deterministic: any indexer or browser that applies the same rules to the same blocks gets the same result. This site lets you run those checks yourself."
- **What is still visible?** "That a protocol transaction happened, when, its size, its fee and the address that paid the fee. For mints and launches, the token and amount are public too. For private transfers, the token, amount, sender and recipient are hidden."
- **What can your server see?** "That you downloaded the public pool data, which every wallet downloads in full. Not your balance, and not which notes are yours. If you use the relayer, it also sees your IP address and the envelope it broadcasts."
- **What is still trusted on signet?** "A single-party development setup for the proving keys, and block data from a public API instead of our own Bitcoin node. Both are replaced before mainnet."
- **What if I lose my phrase or password?** "Your 24 words are the only backup. The password only unlocks this browser; with the words you can restore anywhere. Nobody, including us, can recover your notes."
- **When mainnet?** "After a multi-party setup ceremony, an external audit and our own Bitcoin node. Until then, test coins only."

**12. Final band**
- Serif: "Your bag. Your business."
- Sub: "Private by proof. Anchored to Bitcoin. Checked by you."
- [Open wallet] [Run your own indexer].

**Footer**
- Wordmark plus "Private tokens on Bitcoin."
- Link columns: Product (Mints, Explorer, Wallet) · Verify (Verify, Security, Protocol) · Source (Repository, Run an indexer).
- Mono line: "SIGNET · TEST COINS HAVE NO VALUE · DEVELOPMENT PROVING KEYS".
- "Verifier key sha256 a3f1c09e…9c2e [copy]", with a `YOU` chip once the browser has hashed the downloaded key.
- "Circuit {constraints} constraints · Groth16/BN254".
- Theme segmented control: System / Dark / Light.

## 11. Implementation notes

**Files:**
- `web/index.html`: `lang="en"`, meta, `/theme-boot.js`, `/favicon.svg`.
- `web/public/{theme-boot.js,favicon.svg,og.png}`.
- `web/src/styles/{tokens,base,components,pages}.css`, replacing style.css.
- `web/src/ui/{format,icons,prov,seal,proofprint,sigil,hexmap,transcript,redact,sheet,toast,qr,lattice}.js`.
- `web/src/verify/{engine,mempool,rebuild.worker}.js`. These reuse `src/envelope.mjs`, `src/proof-codec.mjs` and `src/core.mjs`.
- `web/src/router.js`.
- `web/src/views/{landing,mints,token,explorer,block,receipt,lookup,verify,security,protocol,pay,notfound,app-gate,app-create,app-import,app-portfolio,app-send,app-receive,app-mint,app-launch,app-activity,app-notes,app-settings}.js`.
- Wire `keystore.js` into `session.js`: unlock → in-memory key; seal the history; auto-lock timer.

**Server (`server/indexer-server.mjs`):**
- SPA fallback.
- `GET /api/roots?from&to`: at most 2000 heights per request. The receipt reads whole fixed pages from the start height and never asks for one height.
- `GET /api/roots?height=H` stays: `{height, root}`, 404 for a height the indexer has not applied. Only the "test another indexer" checks (Settings, Verify) call it, on the indexer being tested; the receipt never does.
- `GET /api/commitments?to=N`: compact `[commitment, height]` rows for cheap rebuilds.
- Log enrichment: `opName`; `asset` and `ticker` on DEPLOY and MINT only. TRANSACT gets nothing new.
- `GET /api/blocks?limit=24`: per-height operation counts derived from the log.
- `GET /api/relayer` once the relayer exists: `{online, address, fee, queue}`.

**Security headers on HTML responses:**
- CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://mempool.space; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, plus `X-Frame-Options: DENY`, on every HTML response. No route may be framed for now. The planned `/embed/t/:TICKER` widget is the only route that may relax framing, for that exact path, once its view exists; until then framing stays denied, and the client frame guard (`web/src/frame-guard.js`) refuses to mount any page inside a frame.
- Ship it first as `Content-Security-Policy-Report-Only`. Confirm snarkjs proving and verification plus the Unisat flow in Chrome, Firefox and Safari, then enforce.
- Also send `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

**English only:** `test/english.test.mjs` fails on `/[\u0400-\u04FF]/` in any repo text file outside node_modules, build, data and dist. Test counts come from facts.json.

**Facts and units:**
- The landing page, /security and the footer render only values from `facts.json` and live APIs. Missing values show "—".
- Storage keys stay `zkpool.signet.*` until the rename in roadmap 3; then migrate them once.
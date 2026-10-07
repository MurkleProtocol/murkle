# Design notes

Precedence when documents disagree: `SPEC.md` (consensus rules) first, then the interface files (`relay-balance-contract.md`, `batch-contract.md`), then the design notes. The code and its tests are what ships; the "as built" sections record where the code differs from a plan.

| File | Status | What it covers |
|---|---|---|
| `relay-balance.md` | Current | Prepaid relay balances: the rules, invariant I-PAY, privacy as stated to users. `GET /api/relay/info` links to it. |
| `relay-balance-contract.md` | Current | The relay-balance interfaces: request signing, the books, the relayer's endpoints and errors, wallet and CLI behaviour, tests (§9: as built). |
| `batch-contract.md` | Current | Batch relay timing interfaces: epochs, anchors, release, deadlines, copy, CLI flags. The amendment at the end (relay balances) overrides earlier sections. |
| `privacy-level2.md` | Current for stages 1 and 1b; proposals for stages 2 to 4 | Why batch timing has its shape, what each observer learns, failure modes, decisions. |
| `mainnet-readiness.md` | Current (contract) | Mainnet readiness: network selection, per-network pins and keys, strict tickers (V2-02), header verification and the Bitcoin Core source (A-9), the phase-2 ceremony (A-8), the deployment kit, and the proof that signet stays identical. Launch steps: `../MAINNET.md`. |
| `visual.md` | Current | The web design system, components, pages, copy rules and security headers. |
| `relayer.md` | Historical | The retired v1 sponsored ("free") relayer. Its trust model, invariant W-1, submit pipeline, journaling and the "Explorer errors" rule still describe today's relayer where the notes at the top say so. |
| `paid-relay.md` | Superseded, not built | The rejected prepaid-ticket design, kept as a record. Only its stage 0 (retiring the free relayer) shipped. |

Also: `../API.md` (the indexer HTTP API) and `../CLAIMS.md` (what the project may and may not claim).

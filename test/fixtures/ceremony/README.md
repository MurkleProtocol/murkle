# Ceremony test fixtures

- `sanity_decoder.r1cs`: `circom circuits/audit/sanity_decoder.circom --r1cs` (circom 2.2.2), 5 constraints. The
  test ceremony in `test/ceremony.test.mjs` runs on it with a power-6 ptau the test generates.
- `beacon-mainnet-900000.json`: the real Bitcoin mainnet block 900000 and 900001 (hashes and 80-byte headers from mempool.space),
  used as the beacon block of the test ceremony.
- `sanity_decoder.wasm`: `circom ... --wasm` of the same circuit; the test proves and verifies with the ceremony's final key.

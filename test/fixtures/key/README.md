# Key tool test fixtures

- `sanity_decoder.r1cs`: `circom circuits/audit/sanity_decoder.circom --r1cs` (circom 2.2.2), 5 constraints. The tests in
  `test/mainnet-key.test.mjs` build a key on it with a tiny phase-1 file the test generates.
- `sanity_decoder.wasm`: `circom ... --wasm` of the same circuit; the tests prove and verify with the resulting key.

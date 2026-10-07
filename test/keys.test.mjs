import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { commitmentOf, randomField } from "../src/core.mjs";
import { deriveKeys, encodeAddress, decodeAddress, encryptNote, tryDecryptNote, NOTE_CT_LEN } from "../src/keys.mjs";

const ASSET = (840000n << 32n) | 7n;
const alice = deriveKeys(randomBytes(32));
const bob = deriveKeys(randomBytes(32));

const noteFor = (keys, amount = 1234n) => {
  const n = { asset: ASSET, amount, blinding: randomField() };
  const commitment = commitmentOf({ ...n, pubkey: keys.pk });
  return { n, commitment, ct: encryptNote({ ...n, vpk: keys.vpk, commitment }) };
};

test("keys are deterministic from the seed", () => {
  const seed = randomBytes(32);
  const a = deriveKeys(seed);
  const b = deriveKeys(seed);
  assert.equal(a.sk, b.sk);
  assert.deepEqual(a.vpk, b.vpk);
});

test("address round-trips and rejects other prefixes", () => {
  const addr = encodeAddress(alice);
  assert.match(addr, /^mrk1/);
  const back = decodeAddress(addr);
  assert.equal(back.pk, alice.pk);
  assert.deepEqual(back.vpk, alice.vpk);
  assert.throws(() => decodeAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"));
});

test("recipient decrypts the note; ciphertext is exactly 95 bytes", () => {
  const { n, commitment, ct } = noteFor(alice);
  assert.equal(ct.length, NOTE_CT_LEN);
  assert.deepEqual(tryDecryptNote(ct, alice, commitment), n);
});

test("other wallets cannot decrypt", () => {
  const { commitment, ct } = noteFor(alice);
  assert.equal(tryDecryptNote(ct, bob, commitment), null);
});

test("tampered ciphertext or wrong commitment is rejected", () => {
  const { commitment, ct } = noteFor(alice);
  const flipped = Uint8Array.from(ct);
  flipped[50] ^= 1;
  assert.equal(tryDecryptNote(flipped, alice, commitment), null);
  assert.equal(tryDecryptNote(ct, alice, commitment + 1n), null);
});

test("a validly encrypted note whose commitment uses another spend key is rejected", () => {
  // Sender encrypts to Alice's view key but commits to Bob's spend key:
  // Alice must not count a note she cannot spend.
  const n = { asset: ASSET, amount: 5n, blinding: randomField() };
  const commitment = commitmentOf({ ...n, pubkey: bob.pk });
  const ct = encryptNote({ ...n, vpk: alice.vpk, commitment });
  assert.equal(tryDecryptNote(ct, alice, commitment), null);
});

// Crowd Meter tiers: tiers with plain-English reasons from
// synthetic histories. No percentages, no "untraceable", advice never blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TIERS, noteContext, noteTier, weakest, UPPER_BOUND_TIP } from "../web/src/privacy.js";

/** A bulk log: one MINT for our note at `mintHeight`, then `transfers` private transfers spread after it. */
function history({ mintHeight = 100, transfers = 0, spread = 1, rejected = 0 } = {}) {
  const log = [{ height: mintHeight, txid: "mint-tx", ok: true, opName: "MINT" }];
  for (let i = 0; i < transfers; i++) log.push({ height: mintHeight + 1 + Math.floor(i / spread), txid: `t${i}`, ok: true, opName: "TRANSFER" });
  for (let i = 0; i < rejected; i++) log.push({ height: mintHeight + 1, txid: `r${i}`, ok: false, opName: "TRANSFER", reason: "x" });
  return log;
}

const note = { leafIndex: 10, height: 100, txid: "mint-tx" };

test("a freshly minted note is Exposed, with reasons", () => {
  const ctx = noteContext(note, { leaves: 12, height: 102, log: history({ transfers: 1 }) });
  assert.deepEqual(ctx, { notesAfter: 1, transfersSince: 1, blocks: 2, mint: true, leaves: 12 });
  const t = noteTier(ctx);
  assert.equal(t.tier, "exposed");
  assert.equal(t.label, "Exposed");
  assert.ok(t.reasons.some((r) => /public mint/.test(r)));
  assert.ok(t.reasons.some((r) => /1 private transfer happened/.test(r)));
  assert.match(t.advice, /minted 2 blocks ago and only 1 transfer happened since\. Waiting makes the timing link weaker\./);
  assert.equal(t.hidesAmong, 12);
});

test("the tier rises as blocks with transfers arrive", () => {
  const ranks = [];
  for (const [height, transfers, leaves] of [[102, 1, 12], [108, 4, 30], [140, 12, 80], [300, 40, 400]]) {
    const ctx = noteContext(note, { leaves, height, log: history({ transfers, spread: 2 }) });
    ranks.push(noteTier(ctx).rank);
  }
  assert.deepEqual(ranks, [0, 1, 2, 3]);
  assert.deepEqual(ranks.map((r) => TIERS[r]), ["exposed", "weak", "fair", "strong"]);
});

test("only accepted private transfers after the note count", () => {
  const log = [...history({ transfers: 3, rejected: 5 }), { height: 90, txid: "old", ok: true, opName: "TRANSFER" }, { height: 120, txid: "m2", ok: true, opName: "MINT" }];
  const ctx = noteContext({ leafIndex: 0, height: 100 }, { leaves: 50, height: 130, log });
  assert.equal(ctx.transfersSince, 3);
  assert.equal(ctx.mint, false, "only this note's own txid can make it a mint output");
});

test("the planned route caps the tier and says why", () => {
  const ctx = noteContext({ leafIndex: 0, height: 100 }, { leaves: 500, height: 400, log: history({ mintHeight: 99, transfers: 60, spread: 1 }).map((e) => (e.opName === "MINT" ? { ...e, txid: "other" } : e)) });
  assert.equal(noteTier(ctx, { route: "relay" }).tier, "strong");
  const self = noteTier(ctx, { route: "self" });
  assert.equal(self.tier, "fair");
  assert.ok(self.reasons.some((r) => /built-in Bitcoin address/.test(r)));
  const linked = noteTier(ctx, { route: "self-linked" });
  assert.equal(linked.tier, "weak");
  assert.match(linked.advice, /never paid a mint/);
  assert.doesNotMatch(linked.advice, /relayer/, "no advice to use a relayer while relaying is unavailable");
  assert.equal(noteTier(ctx, { route: "unisat" }).tier, "weak");
  const copy = noteTier(ctx, { route: "copy" });
  assert.equal(copy.tier, "fair", "a copied envelope: whoever carries it is tied to it");
  assert.ok(copy.reasons.some((r) => /Whoever carries the copied envelope pays the fee/.test(r)));
});

test("a send is as private as its weakest note", () => {
  const strong = noteTier({ notesAfter: 500, transfersSince: 50, blocks: 500, mint: false, leaves: 600 });
  const weak = noteTier({ notesAfter: 10, transfersSince: 3, blocks: 5, mint: false, leaves: 600 });
  assert.equal(weakest([strong, weak]).tier, "weak");
  assert.equal(weakest([]), null);
});

test("copy stays honest: no percentages, no forbidden words, advice never blocks", () => {
  const all = [];
  for (const blocks of [0, 1, 5, 30, 500]) {
    for (const route of ["relay", "self", "self-linked", "unisat"]) {
      const t = noteTier({ notesAfter: blocks, transfersSince: blocks, blocks, mint: blocks < 5, leaves: blocks + 1 }, { route });
      all.push(...t.reasons, t.advice ?? "", t.label);
      assert.ok(!("blocked" in t) && !("block" in t), "a tier is advice, never a gate");
    }
  }
  all.push(UPPER_BOUND_TIP);
  for (const s of all) {
    assert.ok(!/\d\s*%|percent/i.test(s), `no percentage: ${s}`);
    assert.ok(!/untraceable|fully anonymous|trustless|military-grade|unbreakable/i.test(s), `no forbidden claim: ${s}`);
  }
  assert.match(UPPER_BOUND_TIP, /upper bound/i);
});

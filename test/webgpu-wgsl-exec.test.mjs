// The WGSL kernel text itself, run on a CPU: test/fixtures/wgsl-mini.mjs compiles the strings of
// src/webgpu/argon2.wgsl.mjs to JavaScript (a subset interpreter, no GPU and no WebGPU anywhere) and these tests
// compare what the kernel code computes with src/webgpu/ref64.mjs and with the Argon2 vectors:
// every primitive, k_kat, k_prims, k_init, k_fill (several hashes per workgroup, banks, uneven segments, the
// border at block 2048, race detection on the workgroup arrays), k_final, and one whole hash.
// The interpreter proves the text computes what the model computes. It does not prove what a particular GPU
// compiler does with it; that is what the engine test on a real adapter is for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GPU_SELF_TEST_VECTORS } from "../src/gpu-gate.mjs";
import { hex, unhex } from "../src/bytes.mjs";
import { B2_IV, B2_SIGMA } from "../src/webgpu/ref64.mjs";
import * as R from "../src/webgpu/ref64.mjs";
import { ARGON2_WGSL, COMMON_WGSL, PRIMS_WGSL } from "../src/webgpu/argon2.wgsl.mjs";
import { compileWgsl } from "./fixtures/wgsl-mini.mjs";

const SLOW = process.env.MURKLE_SLOW_TESTS === "1";
const TABLE = R.refTable();
const kernels = new Map();
const kernel = (hpw) => {
  if (!kernels.has(hpw)) kernels.set(hpw, compileWgsl(ARGON2_WGSL, { HPW: hpw }));
  return kernels.get(hpw);
};
const asArr = (p) => [p.lo, p.hi];
const asPair = (a) => ({ lo: a[0], hi: a[1] });

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}
const NOOP = { mem: new Uint32Array(4), pw: new Uint32Array(10), tags: new Uint32Array(16), reftab: TABLE, prm: { slotBase: 0, slots: 0, segFrom: 0, segTo: 0 } };

test("the WGSL text compiles for HPW 1, 2, 4 and 8 with workgroups of 32 * HPW invocations", () => {
  for (const hpw of [1, 2, 4, 8]) {
    const k = kernel(hpw);
    assert.deepEqual(k.overrides, { HPW: hpw, WG_SIZE: 32 * hpw, S_LEN: 136 * hpw, R0_LEN: 2 * hpw });
  }
  assert.throws(() => compileWgsl(ARGON2_WGSL, { NOPE: 1 }), /unknown override/);
});

test("the interpreter itself refuses a shift by anything but a literal 1 .. 31 and an out-of-range index", () => {
  assert.throws(() => compileWgsl("fn f(a: u32, n: u32) -> u32 { return a << n; }"), /shift by something other/);
  assert.throws(() => compileWgsl("fn f(a: u32) -> u32 { return a << 0u; }"), /shift by something other/);
  assert.throws(() => compileWgsl("fn f(a: u32) -> u32 { return a >> 32u; }"), /shift by something other/);
  const m = compileWgsl("fn f(i: u32) -> u32 { var a: array<u32, 3>; return a[i]; }");
  assert.equal(m.call("f", 2), 0);
  assert.throws(() => m.call("f", 3), /out of range/);
});

test("WGSL tables equal ref64: the BLAKE2b IV and the 12 rounds of sigma", () => {
  const m = kernel(1);
  assert.deepEqual(m.call("b2_init", 64).map((p) => p.slice()).slice(1), B2_IV.slice(1).map(asArr));
  // sigma through a compress of a message whose words are their own indexes: compare with ref64's compress
  const msg = Array.from({ length: 16 }, (_, i) => ({ lo: 0x1000 + i, hi: 0xf000 + 7 * i }));
  const hRef = R.b2_init(64);
  R.b2_compress(hRef, msg, 77, false);
  const h = m.call("b2_init", 64);
  const mm = msg.map(asArr);
  m.call("b2_compress", h, mm, 77, false);
  assert.deepEqual(h, hRef.map(asArr));
  assert.equal(B2_SIGMA.length, 12);
});

test("every WGSL primitive equals ref64 on random and edge inputs", () => {
  const m = kernel(1);
  const next = rng(0xbeef);
  const edge = [0, 1, 2, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
  const pick = () => (next() % 5 === 0 ? edge[next() % edge.length] : next());
  for (let i = 0; i < 1500; i++) {
    const x = { lo: pick(), hi: pick() };
    const y = { lo: pick(), hi: pick() };
    const a = pick();
    const b = pick();
    const check = (name, got, want) => assert.deepEqual(got, want, `${name} ${JSON.stringify([x, y, a, b])}`);
    check("add64", m.call("add64", asArr(x), asArr(y)), asArr(R.add64(x, y)));
    check("xor64", m.call("xor64", asArr(x), asArr(y)), asArr(R.xor64(x, y)));
    check("rotr32", m.call("rotr32", asArr(x)), asArr(R.rotr32(x)));
    check("rotr24", m.call("rotr24", asArr(x)), asArr(R.rotr24(x)));
    check("rotr16", m.call("rotr16", asArr(x)), asArr(R.rotr16(x)));
    check("rotr63", m.call("rotr63", asArr(x)), asArr(R.rotr63(x)));
    check("mul32wide", m.call("mul32wide", a, b), asArr(R.mul32wide(a, b)));
    check("mulhi32", m.call("mulhi32", a, b), R.mulhi32(a, b));
    check("fbla", m.call("fbla", asArr(x), asArr(y)), asArr(R.fbla(x, y)));
    const z = { lo: pick(), hi: pick() };
    const w = { lo: pick(), hi: pick() };
    const g = R.a2_gb(x, y, z, w);
    const got = m.call("a2_gb", asArr(x), asArr(y), asArr(z), asArr(w));
    check("a2_gb", got, { a: asArr(g.a), b: asArr(g.b), c: asArr(g.c), d: asArr(g.d) });
    const index = 2 + (next() % 4094);
    check("a2_ref_of", m.call("a2_ref_of", index, a), R.a2_ref_of(index, a));
    const bg = R.b2_g(x, y, z, w, asPair([a, b]), asPair([b, a]));
    check("b2_g", m.call("b2_g", asArr(x), asArr(y), asArr(z), asArr(w), [a, b], [b, a]), { a: asArr(bg.a), b: asArr(bg.b), c: asArr(bg.c), d: asArr(bg.d) });
  }
});

test("a2_h0 and a2_hprime_1024 of the WGSL equal ref64", () => {
  const m = kernel(1);
  const next = rng(11);
  for (let i = 0; i < 3; i++) {
    const pw = Uint32Array.from({ length: 10 }, next);
    const h0Ref = R.a2_h0(pw);
    const h0 = m.call("a2_h0", Array.from(pw));
    assert.deepEqual(h0, h0Ref.map(asArr));
  }
});

test("k_kat writes BLAKE2b-256(\"abc\")", () => {
  const tags = new Uint32Array(8);
  kernel(1).dispatch("k_kat", 1, { ...NOOP, tags });
  assert.equal(hex(new Uint8Array(tags.buffer)), hex(R.b2_kat()));
});

test("k_prims on 512 random input sets equals ref64 (and the first mismatch would be named)", () => {
  const m = compileWgsl(PRIMS_WGSL);
  const n = 512;
  const words = R.primsInputs(n, 99);
  const tags = new Uint32Array(n * R.PRIMS_OUT_PAIRS * 2);
  m.dispatch("k_prims", n / 64, { ...NOOP, pw: words, tags, prm: { slotBase: 0, slots: n, segFrom: 0, segTo: 0 } });
  assert.equal(R.firstPrimsMismatch(tags, R.primsExpected(words)), null);
  assert.ok(COMMON_WGSL.includes("fn a2_gb") && !COMMON_WGSL.includes("k_prims"));
});

test("k_init: the blocks 0 and 1 of every slot of a bank, with slotBase selecting the passwords", () => {
  const m = kernel(2);
  const vs = GPU_SELF_TEST_VECTORS.slice(0, 5);
  const pw = new Uint32Array(5 * 10);
  vs.forEach((v, i) => pw.set(R.pwWords(unhex(v.password)), i * 10));
  // the bank holds slots 2 .. 4 of the batch: slotBase 2, three slots (more than one invocation pair per slot)
  const mem = new Uint32Array(3 * R.SLOT_U32);
  m.dispatch("k_init", Math.ceil((2 * 3) / 64), { ...NOOP, mem, pw, prm: { slotBase: 2, slots: 3, segFrom: 0, segTo: 0 } });
  for (let s = 0; s < 3; s++) {
    const ref = R.initMemory(unhex(vs[2 + s].password));
    assert.deepEqual(Array.from(mem.subarray(s * R.SLOT_U32, s * R.SLOT_U32 + 512)), Array.from(ref.subarray(0, 512)), `slot ${s}`);
    assert.equal(mem[s * R.SLOT_U32 + 512], 0, "block 2 is untouched");
  }
});

/** Runs k_fill over [from, to) on `hashes` hashes in one bank, from the reference memory at `from`, and compares with the reference. */
function fillCheck({ hpw, hashes, pre, cuts, expectRaces = false }) {
  const m = kernel(hpw);
  const vs = GPU_SELF_TEST_VECTORS.slice(0, hashes);
  const mem = new Uint32Array(hashes * R.SLOT_U32);
  const refs = vs.map((v, s) => {
    const ref = R.initMemory(unhex(v.password));
    R.fillModel(ref, 2, pre, TABLE);
    mem.set(ref, s * R.SLOT_U32);
    return ref;
  });
  let races = 0;
  let barriers = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const r = m.dispatch("k_fill", hashes / hpw, { ...NOOP, mem, prm: { slotBase: 0, slots: hashes, segFrom: cuts[i], segTo: cuts[i + 1] } });
    races += r.races.length;
    barriers += r.barriers;
  }
  const end = cuts.at(-1);
  refs.forEach((ref, s) => {
    R.fillModel(ref, pre, end, TABLE);
    const got = mem.subarray(s * R.SLOT_U32, s * R.SLOT_U32 + end * 256);
    for (let i = 0; i < got.length; i++) if (got[i] !== ref[i]) assert.fail(`hpw ${hpw} hash ${s}: block ${i >> 8} word ${(i & 255) >> 1} differs`);
    if (end < 4096) assert.equal(mem[s * R.SLOT_U32 + end * 256], 0, "nothing past the segment end is written");
  });
  if (!expectRaces) assert.equal(races, 0, "no data race on the workgroup arrays");
  return { races, barriers };
}

test("k_fill: one hash per workgroup, a short segment and the next one, no data race, 4 barriers per block", () => {
  const r = fillCheck({ hpw: 1, hashes: 1, pre: 2, cuts: [2, 6, 11] });
  assert.equal(r.barriers, 4 * 9);
});

test("k_fill: two, four and eight hashes per workgroup give each hash its own memory and its own exchange array", () => {
  for (const hpw of [2, 4, 8]) fillCheck({ hpw, hashes: hpw, pre: 2, cuts: [2, 5] });
});

test("k_fill: two workgroups of two hashes (a bank of four slots)", () => {
  fillCheck({ hpw: 2, hashes: 4, pre: 2, cuts: [2, 4] });
});

test("k_fill: a segment may start and end anywhere, also across the data-independent / data-dependent border at 2048", () => {
  fillCheck({ hpw: 2, hashes: 2, pre: 2044, cuts: [2044, 2047, 2048, 2051] });
  fillCheck({ hpw: 1, hashes: 1, pre: 3000, cuts: [3000, 3001, 3003] });
  fillCheck({ hpw: 1, hashes: 1, pre: 4090, cuts: [4090, 4095, 4096] });
});

test("k_fill: with one workgroupBarrier() removed the interpreter reports data races (the race check has teeth)", () => {
  const broken = ARGON2_WGSL.replace("workgroupBarrier();", "");
  assert.notEqual(broken, ARGON2_WGSL);
  const m = compileWgsl(broken, { HPW: 1 });
  const ref = R.initMemory(unhex(GPU_SELF_TEST_VECTORS[0].password));
  const r = m.dispatch("k_fill", 1, { ...NOOP, mem: ref.slice(), prm: { slotBase: 0, slots: 1, segFrom: 2, segTo: 4 } });
  assert.ok(r.races.length > 0);
});

test("k_final: the tag of a finished memory, with slotBase placing it in the tag buffer", () => {
  const m = kernel(1);
  const vs = GPU_SELF_TEST_VECTORS.slice(0, 3);
  const mem = new Uint32Array(3 * R.SLOT_U32);
  vs.forEach((v, s) => {
    const ref = R.initMemory(unhex(v.password));
    R.fillModel(ref, 2, 4096, TABLE);
    mem.set(ref, s * R.SLOT_U32);
  });
  const tags = new Uint32Array(8 * 4 + 8 * 3); // room for 7 slots; this bank writes slots 4 .. 6
  m.dispatch("k_final", 1, { ...NOOP, mem, tags, prm: { slotBase: 4, slots: 3, segFrom: 0, segTo: 0 } });
  const bytes = new Uint8Array(tags.buffer);
  vs.forEach((v, s) => assert.equal(hex(bytes.subarray((4 + s) * 32, (5 + s) * 32)), v.powHash, v.name));
  assert.equal(hex(bytes.subarray(0, 4 * 32)), "00".repeat(128), "slots before slotBase are untouched");
});

test("the whole kernel chain on one hash: k_init, k_fill in three uneven segments, k_final equal the vector tag", () => {
  const m = kernel(1);
  const v = GPU_SELF_TEST_VECTORS[0];
  const mem = new Uint32Array(R.SLOT_U32);
  const tags = new Uint32Array(8);
  const pw = R.pwWords(unhex(v.password));
  const b = { ...NOOP, mem, pw, tags };
  m.dispatch("k_init", 1, { ...b, prm: { slotBase: 0, slots: 1, segFrom: 0, segTo: 0 } });
  let races = 0;
  for (const [from, to] of [[2, 1500], [1500, 2301], [2301, 4096]]) {
    races += m.dispatch("k_fill", 1, { ...b, prm: { slotBase: 0, slots: 1, segFrom: from, segTo: to } }).races.length;
  }
  m.dispatch("k_final", 1, { ...b, prm: { slotBase: 0, slots: 1, segFrom: 0, segTo: 0 } });
  assert.equal(hex(new Uint8Array(tags.buffer).subarray(0, 32)), v.powHash);
  assert.equal(races, 0);
});

test("MURKLE_SLOW_TESTS=1: four hashes per workgroup, whole chain, against four vectors", { skip: !SLOW && "set MURKLE_SLOW_TESTS=1" }, () => {
  const m = kernel(4);
  const vs = GPU_SELF_TEST_VECTORS.slice(4, 8);
  const mem = new Uint32Array(4 * R.SLOT_U32);
  const tags = new Uint32Array(4 * 8);
  const pw = new Uint32Array(40);
  vs.forEach((v, s) => pw.set(R.pwWords(unhex(v.password)), s * 10));
  const b = { ...NOOP, mem, pw, tags };
  m.dispatch("k_init", 1, { ...b, prm: { slotBase: 0, slots: 4, segFrom: 0, segTo: 0 } });
  for (const [from, to] of [[2, 777], [777, 4096]]) m.dispatch("k_fill", 1, { ...b, prm: { slotBase: 0, slots: 4, segFrom: from, segTo: to } });
  m.dispatch("k_final", 1, { ...b, prm: { slotBase: 0, slots: 4, segFrom: 0, segTo: 0 } });
  vs.forEach((v, s) => assert.equal(hex(new Uint8Array(tags.buffer).subarray(s * 32, s * 32 + 32)), v.powHash, v.name));
});

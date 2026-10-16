// Static checks of the WGSL text (src/webgpu/argon2.wgsl.mjs): no 64-bit types or extensions, every shift by a
// literal 1 .. 31, the functions of ref64 and the entry points are there, exactly four barriers in k_fill,
// no WGSL reserved word used as a name, the bindings as the engine expects them, the GPL header and the marker.
// The behaviour of the text is checked by test/webgpu-wgsl-exec.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ARGON2_WGSL, COMMON_WGSL, PRIMS_WGSL } from "../src/webgpu/argon2.wgsl.mjs";

const FILE = readFileSync(new URL("../src/webgpu/argon2.wgsl.mjs", import.meta.url), "utf8");
const MODULES = { COMMON_WGSL, ARGON2_WGSL, PRIMS_WGSL };
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("no 64-bit integer types, no extension directives, no subgroup built-ins", () => {
  for (const [name, text] of Object.entries(MODULES)) {
    assert.equal(/\b[ui]64\b/.test(text), false, `${name}: 64-bit integer type`);
    assert.equal(/\benable\b/.test(text), false, `${name}: enable directive`);
    assert.equal(/\brequires\b|\bdiagnostic\b/.test(text), false, `${name}: directive`);
    assert.equal(/subgroup/i.test(text), false, `${name}: subgroup`);
    assert.equal(/\bf16\b/.test(text), false, `${name}: shader-f16`);
  }
});

test("every shift amount is a literal in 1..31 (no shift by 0, 32 or a runtime count)", () => {
  for (const [name, text] of Object.entries(MODULES)) {
    const code = stripComments(text);
    let shifts = 0;
    // shifts are written " << 8u " with spaces; a template closer has no space before it
    for (const m of code.matchAll(/(<<|>>)/g)) {
      const before = code[m.index - 1];
      if (m[0] === "<<") assert.ok(/\s/.test(before), `${name}: "<<" glued to ${before}`);
      if (!/\s/.test(before)) {
        assert.ok(m[0] === ">>" && /[>\w]/.test(before), `${name}: ">>" is neither a shift nor a template closer near ${code.slice(m.index - 20, m.index + 10)}`);
        continue;
      }
      const rest = /^\s+(\d+)u\b/.exec(code.slice(m.index + 2));
      assert.ok(rest, `${name}: shift by something other than a literal near "${code.slice(m.index - 20, m.index + 12).replace(/\n/g, " ")}"`);
      const n = Number(rest[1]);
      assert.ok(n >= 1 && n <= 31, `${name}: shift by ${n}`);
      shifts++;
    }
    assert.ok(shifts > 10, `${name}: ${shifts} shifts found`);
  }
});

test("every function of ref64's export list exists as `fn <name>` in COMMON_WGSL", () => {
  for (const f of ["add64", "rotr32", "rotr24", "rotr16", "rotr63", "mul32wide", "mulhi32", "fbla", "a2_gb", "b2_compress", "a2_h0", "a2_hprime_1024", "a2_ref_of"]) {
    assert.ok(new RegExp(`\\bfn ${f}\\(`).test(COMMON_WGSL), `fn ${f}`);
  }
  for (const f of ["xor64", "b2_g", "b2_init", "b2_hash1", "sidx", "posR", "posC"]) assert.ok(new RegExp(`\\bfn ${f}\\(`).test(COMMON_WGSL), `fn ${f}`);
});

test("entry points: k_init, k_fill, k_final, k_kat in ARGON2_WGSL; k_prims only in PRIMS_WGSL", () => {
  const entry = (text, name) => new RegExp(`@compute @workgroup_size\\([^)]*\\)\\s*fn ${name}\\(`).test(text);
  for (const k of ["k_init", "k_fill", "k_final", "k_kat"]) {
    assert.ok(entry(ARGON2_WGSL, k), k);
    assert.equal(entry(COMMON_WGSL, k), false, `${k} is not in COMMON`);
    assert.equal(entry(PRIMS_WGSL, k), false, `${k} is not in PRIMS`);
  }
  assert.ok(entry(PRIMS_WGSL, "k_prims"));
  assert.equal(/k_prims/.test(ARGON2_WGSL), false);
  assert.equal(/k_prims/.test(COMMON_WGSL), false);
  assert.equal((ARGON2_WGSL.match(/@compute/g) ?? []).length, 4);
  assert.match(ARGON2_WGSL, /@compute @workgroup_size\(WG_SIZE\)\s*fn k_fill\(/);
  assert.match(ARGON2_WGSL, /@compute @workgroup_size\(64\)\s*fn k_init\(/);
  assert.match(ARGON2_WGSL, /@compute @workgroup_size\(64\)\s*fn k_final\(/);
  assert.match(ARGON2_WGSL, /@compute @workgroup_size\(1\)\s*fn k_kat\(/);
});

test("exactly 4 workgroupBarrier() inside k_fill, and none anywhere else", () => {
  const code = stripComments(ARGON2_WGSL);
  const start = code.indexOf("fn k_fill(");
  const end = code.indexOf("@compute", start);
  assert.ok(start > 0 && end > start);
  assert.equal((code.slice(start, end).match(/workgroupBarrier\(\)/g) ?? []).length, 4);
  assert.equal((code.match(/workgroupBarrier\(\)/g) ?? []).length, 4);
  assert.equal(/storageBarrier|textureBarrier|workgroupUniformLoad/.test(code), false, "no other barrier kinds: every lane reads only words it wrote itself");
});

test("the bindings are the ones the engine builds its layout from", () => {
  const code = stripComments(COMMON_WGSL);
  assert.match(code, /@group\(0\) @binding\(0\) var<storage, read_write> mem: array<vec2<u32>>;/);
  assert.match(code, /@group\(0\) @binding\(1\) var<storage, read> pw: array<u32>;/);
  assert.match(code, /@group\(0\) @binding\(2\) var<storage, read_write> tags: array<vec2<u32>>;/);
  assert.match(code, /@group\(0\) @binding\(3\) var<storage, read> reftab: array<u32>;/);
  assert.match(code, /@group\(0\) @binding\(4\) var<uniform> prm: Params;/);
  assert.match(code, /struct Params \{\s*slotBase: u32,\s*slots: u32,\s*segFrom: u32,\s*segTo: u32,\s*\}/);
  assert.match(code, /override HPW: u32 = 2u;/);
  assert.equal((code.match(/@binding\(/g) ?? []).length, 5);
});

// WGSL reserved words (the spec's list); none may be used as a name
const RESERVED = `NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await become binding_array cast catch class
co_await co_return co_yield coherent column_major common compile compile_fragment concept const_cast consteval constexpr constinit crate
debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export extends extern external fallthrough filter final
finally friend from fxgroup get goto groupshared highp impl implements import inline instanceof interface layout lowp macro macro_rules
match mediump meta mod module move mut mutable namespace new nil noexcept noinline nointerpolation noperspective null nullptr of operator
package packoffset partition pass patch pixelfragment precise precision premerge priv protected pub public readonly ref regardless
register reinterpret_cast require resource restrict self set shared sizeof smooth snorm static static_assert static_cast std subroutine
super target template this thread_local throw trait try type typedef typeid typename typeof union unless unorm unsafe unsized use using
varying virtual volatile wgsl where with writeonly yield`.split(/\s+/);

test("no WGSL reserved word is used as an identifier", () => {
  const code = stripComments(ARGON2_WGSL + PRIMS_WGSL);
  const words = new Set(code.match(/[A-Za-z_][A-Za-z0-9_]*/g));
  const clash = RESERVED.filter((w) => words.has(w));
  assert.deepEqual(clash, []);
});

test("the GPL header and the kernel marker are present, and the file is plain ASCII with LF line endings", () => {
  assert.match(FILE, /^\/\/ SPDX-License-Identifier: GPL-3\.0-or-later/);
  assert.match(FILE, /GNU General Public License as published by the Free Software Foundation, either version 3/);
  assert.equal(/Additional permission|NVIDIA CUDA/.test(FILE), false, "the CUDA section-7 paragraph is not copied");
  for (const [name, text] of Object.entries(MODULES)) assert.match(text, /\/\/ murkle-webgpu-kernel/, name);
  assert.equal(/[^\x00-\x7f]/.test(FILE), false, "ASCII only");
  assert.equal(FILE.includes("\r"), false, "LF line endings");
});

test("ARGON2 and PRIMS are COMMON plus their kernels", () => {
  assert.ok(ARGON2_WGSL.startsWith(COMMON_WGSL));
  assert.ok(PRIMS_WGSL.startsWith(COMMON_WGSL));
  assert.ok(ARGON2_WGSL.length > COMMON_WGSL.length && PRIMS_WGSL.length > COMMON_WGSL.length);
});

test("the workgroup memory of k_fill fits the default 16 KiB for every HPW", () => {
  // S: HPW * 136 words of 8 bytes, R0: HPW * 2 words of 8 bytes
  for (const hpw of [1, 2, 4, 8]) assert.ok(hpw * (136 + 2) * 8 <= 16384, `HPW ${hpw}`);
  assert.equal(8 * (136 + 2) * 8, 8832);
  assert.match(ARGON2_WGSL, /override S_LEN: u32 = HPW \* 136u;/);
  assert.match(ARGON2_WGSL, /override R0_LEN: u32 = HPW \* 2u;/);
});

// A small interpreter for the subset of WGSL that src/webgpu/argon2.wgsl.mjs uses. It exists so that the kernel
// text itself can be run on a CPU, with no GPU and no WebGPU implementation anywhere: tests compile the WGSL
// strings to JavaScript and run them against ref64 and the Argon2 vectors. It is NOT a general WGSL
// implementation: only u32 scalars, vec2<u32>, fixed arrays, structs, pointers to local arrays, the control flow
// and the builtins the kernel needs. Every unsupported construct throws, so the kernel cannot quietly grow
// out of what this checks.
//
// Semantics it enforces on purpose:
//   - u32 arithmetic wraps; shifts take their count mod 32 (like WGSL) and the kernel is checked to use literals 1 .. 31;
//   - an index out of range throws (a GPU would clamp or return zeros and hide the bug);
//   - a workgroup runs its invocations as coroutines that stop at each workgroupBarrier(); all of them must reach
//     the same barrier (uniform control flow), and the accesses to workgroup arrays are recorded per barrier
//     interval so that a data race (one invocation writes an address another reads or writes in the same
//     interval) is reported.
// Value semantics: aggregates are copied on var initialisation, assignment and store; pointers to local arrays
// are the arrays themselves.

// ---------------------------------------------------------------- tokens

const PUNCT = ["<<=", ">>=", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "++", "--", "->", "+=", "-=", "|=", "&=", "^=", "@", "(", ")", "{", "}", "[", "]", "<", ">", ",", ";", ":", ".", "=", "+", "-", "*", "/", "%", "&", "|", "^", "~", "!"];

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) throw new Error("unterminated comment");
      i = e + 2;
    } else if (/[0-9]/.test(c)) {
      const m = /^(0[xX][0-9a-fA-F]+|[0-9]+)([ui]?)/.exec(src.slice(i));
      if (!m) throw new Error(`bad number at ${i}`);
      if (m[2] === "i") throw new Error("i32 literals are not supported");
      toks.push({ t: "num", v: Number(m[1]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      toks.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else {
      const p = PUNCT.find((q) => src.startsWith(q, i));
      if (!p) throw new Error(`unexpected character ${JSON.stringify(c)}`);
      toks.push({ t: "p", v: p });
      i += p.length;
    }
  }
  toks.push({ t: "eof", v: "" });
  return toks;
}

// ---------------------------------------------------------------- parser

class Parser {
  constructor(src) {
    this.toks = tokenize(src);
    this.i = 0;
  }
  get tok() {
    return this.toks[this.i];
  }
  is(v) {
    return this.tok.t !== "num" && this.tok.v === v;
  }
  eat(v) {
    if (!this.is(v)) throw new Error(`expected "${v}" but found "${this.tok.v}" (token ${this.i})`);
    return this.toks[this.i++];
  }
  maybe(v) {
    if (this.is(v)) {
      this.i++;
      return true;
    }
    return false;
  }
  ident() {
    if (this.tok.t !== "id") throw new Error(`expected an identifier but found "${this.tok.v}"`);
    return this.toks[this.i++].v;
  }

  module() {
    const m = { aliases: {}, structs: {}, overrides: [], globals: [], fns: {} };
    while (this.tok.t !== "eof") {
      const attrs = this.attributes();
      const kw = this.ident();
      if (kw === "alias") {
        const name = this.ident();
        this.eat("=");
        m.aliases[name] = this.type();
        this.eat(";");
      } else if (kw === "struct") {
        const name = this.ident();
        this.eat("{");
        const members = [];
        while (!this.is("}")) {
          const mn = this.ident();
          this.eat(":");
          members.push({ name: mn, type: this.type() });
          if (!this.maybe(",")) break;
        }
        this.eat("}");
        m.structs[name] = members;
      } else if (kw === "override") {
        const name = this.ident();
        let type = null;
        if (this.maybe(":")) type = this.type();
        let init = null;
        if (this.maybe("=")) init = this.expr();
        this.eat(";");
        m.overrides.push({ name, type, init });
      } else if (kw === "var") {
        const space = [];
        if (this.maybe("<")) {
          space.push(this.ident());
          if (this.maybe(",")) space.push(this.ident());
          this.eat(">");
        }
        const name = this.ident();
        this.eat(":");
        const type = this.type();
        let init = null;
        if (this.maybe("=")) init = this.expr();
        this.eat(";");
        m.globals.push({ name, space: space[0] ?? "private", access: space[1] ?? null, type, init, attrs });
      } else if (kw === "fn") {
        const f = this.fn(attrs);
        m.fns[f.name] = f;
      } else throw new Error(`unsupported declaration "${kw}"`);
    }
    return m;
  }

  attributes() {
    const attrs = [];
    while (this.maybe("@")) {
      const name = this.ident();
      const args = [];
      if (this.maybe("(")) {
        while (!this.is(")")) {
          args.push(this.tok.t === "id" && this.toks[this.i + 1].v !== "(" && this.toks[this.i + 1].v !== "*" ? { k: "id", name: this.ident() } : this.expr());
          if (!this.maybe(",")) break;
        }
        this.eat(")");
      }
      attrs.push({ name, args });
    }
    return attrs;
  }

  // type: name [ < arg, ... > ]; the closing ">>" of nested templates is split in place
  type() {
    const name = this.ident();
    if (!this.is("<")) return { name, args: [] };
    this.eat("<");
    const args = [];
    for (;;) {
      if (this.tok.t === "num") args.push({ k: "num", v: this.toks[this.i++].v });
      else args.push(this.type());
      if (!this.maybe(",")) break;
    }
    this.closeTemplate();
    return { name, args };
  }
  closeTemplate() {
    if (this.is(">")) this.i++;
    else if (this.is(">>")) this.toks[this.i] = { t: "p", v: ">" };
    else throw new Error(`expected ">" but found "${this.tok.v}"`);
  }

  fn(attrs) {
    const name = this.ident();
    this.eat("(");
    const params = [];
    while (!this.is(")")) {
      const pa = this.attributes();
      const pn = this.ident();
      this.eat(":");
      params.push({ name: pn, type: this.type(), attrs: pa });
      if (!this.maybe(",")) break;
    }
    this.eat(")");
    let ret = null;
    if (this.maybe("->")) ret = this.type();
    return { name, params, ret, attrs, body: this.block() };
  }

  block() {
    this.eat("{");
    const out = [];
    while (!this.is("}")) out.push(this.stmt());
    this.eat("}");
    return out;
  }

  stmt() {
    if (this.is("{")) return { k: "block", body: this.block() };
    if (this.is(";")) {
      this.i++;
      return { k: "block", body: [] };
    }
    if (this.tok.t === "id") {
      const kw = this.tok.v;
      if (kw === "let" || kw === "var" || kw === "const") {
        const s = this.declaration();
        this.eat(";");
        return s;
      }
      if (kw === "return") {
        this.i++;
        if (this.maybe(";")) return { k: "return", e: null };
        const e = this.expr();
        this.eat(";");
        return { k: "return", e };
      }
      if (kw === "if") return this.ifStmt();
      if (kw === "for") return this.forStmt();
      if (kw === "continue" || kw === "break") {
        this.i++;
        this.eat(";");
        return { k: kw };
      }
    }
    const s = this.simple();
    this.eat(";");
    return s;
  }

  declaration() {
    const kw = this.ident();
    const name = this.ident();
    let type = null;
    if (this.maybe(":")) type = this.type();
    let init = null;
    if (this.maybe("=")) init = this.expr();
    if (kw !== "var" && !init) throw new Error(`${kw} ${name} needs an initializer`);
    return { k: "decl", kw, name, type, init };
  }

  // assignment, increment or a call
  simple() {
    const lhs = this.expr();
    if (this.maybe("++")) return { k: "incr", target: lhs, d: 1 };
    if (this.maybe("--")) return { k: "incr", target: lhs, d: -1 };
    for (const op of ["=", "+=", "-=", "|=", "&=", "^="]) {
      if (this.maybe(op)) return { k: "assign", op, target: lhs, e: this.expr() };
    }
    if (lhs.k !== "call") throw new Error("a statement must be an assignment, an increment or a call");
    return { k: "callstmt", e: lhs };
  }

  ifStmt() {
    this.eat("if");
    this.eat("(");
    const cond = this.expr();
    this.eat(")");
    const then = this.block();
    let els = null;
    if (this.maybe("else")) els = this.is("if") ? [this.ifStmt()] : this.block();
    return { k: "if", cond, then, els };
  }

  forStmt() {
    this.eat("for");
    this.eat("(");
    const init = this.is(";") ? null : this.declaration();
    this.eat(";");
    const cond = this.is(";") ? null : this.expr();
    this.eat(";");
    const cont = this.is(")") ? null : this.simple();
    this.eat(")");
    return { k: "for", init, cond, cont, body: this.block() };
  }

  // precedence climbing
  expr() {
    return this.binary(0);
  }
  binary(minPrec) {
    let lhs = this.unary();
    for (;;) {
      const op = this.tok.t === "p" ? this.tok.v : null;
      const prec = op ? BIN_PREC[op] : undefined;
      if (prec === undefined || prec < minPrec) return lhs;
      this.i++;
      const rhs = this.binary(prec + 1);
      lhs = { k: "bin", op, a: lhs, b: rhs };
    }
  }
  unary() {
    for (const op of ["-", "!", "~", "*", "&"]) {
      if (this.is(op)) {
        this.i++;
        return { k: "un", op, e: this.unary() };
      }
    }
    return this.postfix(this.primary());
  }
  postfix(e) {
    for (;;) {
      if (this.maybe(".")) e = { k: "member", e, name: this.ident() };
      else if (this.maybe("[")) {
        const i = this.expr();
        this.eat("]");
        e = { k: "index", e, i };
      } else return e;
    }
  }
  primary() {
    const t = this.tok;
    if (t.t === "num") {
      this.i++;
      return { k: "num", v: t.v };
    }
    if (this.maybe("(")) {
      const e = this.expr();
      this.eat(")");
      return { k: "paren", e };
    }
    if (t.t === "id") {
      if (t.v === "true" || t.v === "false") {
        this.i++;
        return { k: "bool", v: t.v === "true" };
      }
      const next = this.toks[this.i + 1].v;
      if (TEMPLATED.has(t.v) && next === "<") {
        const type = this.type();
        this.eat("(");
        return { k: "ctor", type, args: this.args() };
      }
      this.i++;
      if (this.is("(")) {
        this.i++;
        return { k: "call", name: t.v, args: this.args() };
      }
      return { k: "id", name: t.v };
    }
    throw new Error(`unexpected "${t.v}" in an expression`);
  }
  args() {
    const out = [];
    while (!this.is(")")) {
      out.push(this.expr());
      if (!this.maybe(",")) break;
    }
    this.eat(")");
    return out;
  }
}

const TEMPLATED = new Set(["vec2", "vec3", "vec4", "array", "ptr"]);
const BIN_PREC = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, ">": 7, "<=": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10 };

// ---------------------------------------------------------------- runtime

const u32 = (x) => x >>> 0;

class Vec2Buf {
  constructor(words, name) {
    this.words = words;
    this.name = name;
    this.length = words.length >> 1;
  }
  get(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.length) throw new RangeError(`${this.name}[${i}] is out of range (length ${this.length})`);
    return [this.words[2 * i], this.words[2 * i + 1]];
  }
  set(i, v) {
    if (!Number.isInteger(i) || i < 0 || i >= this.length) throw new RangeError(`${this.name}[${i}] is out of range (length ${this.length})`);
    this.words[2 * i] = v[0];
    this.words[2 * i + 1] = v[1];
  }
}

/** Workgroup memory that records who touched what in which barrier interval. */
class WgArray {
  constructor(name, length, sched) {
    this.name = name;
    this.data = Array.from({ length }, () => [0, 0]);
    this.length = length;
    this.sched = sched;
  }
  note(kind, i) {
    this.sched.record(this.name, kind, i);
  }
  get(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.length) throw new RangeError(`${this.name}[${i}] is out of range (length ${this.length})`);
    this.note("read", i);
    return this.data[i];
  }
  set(i, v) {
    if (!Number.isInteger(i) || i < 0 || i >= this.length) throw new RangeError(`${this.name}[${i}] is out of range (length ${this.length})`);
    this.note("write", i);
    this.data[i] = v;
  }
}

function copy(v) {
  if (typeof v !== "object" || v === null) return v;
  if (Array.isArray(v)) return v.map(copy);
  const o = {};
  for (const k of Object.keys(v)) o[k] = copy(v[k]);
  return o;
}

function ew(f) {
  return (a, b) => (typeof a === "number" ? f(a, b) : [f(a[0], b[0]), f(a[1], b[1])]);
}
const OPS = {
  add: ew((a, b) => (a + b) >>> 0),
  sub: ew((a, b) => (a - b) >>> 0),
  mul: ew((a, b) => Math.imul(a, b) >>> 0),
  and: ew((a, b) => (a & b) >>> 0),
  or: ew((a, b) => (a | b) >>> 0),
  xor: ew((a, b) => (a ^ b) >>> 0),
  shl: ew((a, b) => (a << (b & 31)) >>> 0),
  shr: ew((a, b) => a >>> (b & 31)),
  div: ew((a, b) => (b === 0 ? a : Math.floor(a / b) >>> 0)),
  mod: ew((a, b) => (b === 0 ? a : a % b)),
};
const BIN_NAMES = { "+": "add", "-": "sub", "*": "mul", "&": "and", "|": "or", "^": "xor", "<<": "shl", ">>": "shr", "/": "div", "%": "mod" };
const CMP = { "<": "<", ">": ">", "<=": "<=", ">=": ">=", "==": "===", "!=": "!==" };

function getIdx(a, i) {
  if (Array.isArray(a)) {
    if (!Number.isInteger(i) || i < 0 || i >= a.length) throw new RangeError(`index ${i} is out of range (length ${a.length})`);
    return a[i];
  }
  if (a instanceof Vec2Buf || a instanceof WgArray) return a.get(i);
  if (ArrayBuffer.isView(a)) {
    if (!Number.isInteger(i) || i < 0 || i >= a.length) throw new RangeError(`storage index ${i} is out of range (length ${a.length})`);
    return a[i];
  }
  throw new Error("indexing something that is not an array");
}
function setIdx(a, i, v) {
  if (Array.isArray(a)) {
    if (!Number.isInteger(i) || i < 0 || i >= a.length) throw new RangeError(`index ${i} is out of range (length ${a.length})`);
    a[i] = v;
  } else if (a instanceof Vec2Buf || a instanceof WgArray) a.set(i, v);
  else if (ArrayBuffer.isView(a)) {
    if (!Number.isInteger(i) || i < 0 || i >= a.length) throw new RangeError(`storage index ${i} is out of range (length ${a.length})`);
    a[i] = v;
  } else throw new Error("indexing something that is not an array");
}
const SWZ = { x: 0, y: 1 };
const isSwizzle = (n) => /^[xy]{1,2}$/.test(n);
function getMember(v, name) {
  if (isSwizzle(name)) {
    if (name.length === 1) return v[SWZ[name]];
    return [v[SWZ[name[0]]], v[SWZ[name[1]]]];
  }
  if (!(name in v)) throw new Error(`no member ${name}`);
  return v[name];
}
function setMember(v, name, x) {
  if (isSwizzle(name) && name.length === 1) v[SWZ[name]] = x;
  else if (!isSwizzle(name)) v[name] = x;
  else throw new Error("assignment to a multi-component swizzle");
}

const RT = { copy, OPS, getIdx, setIdx, getMember, setMember };

// ---------------------------------------------------------------- code generation

const mangle = (n) => `v_${n}`;

class Gen {
  constructor(mod, constants) {
    this.mod = mod;
    this.constants = constants;
    this.fnInfo = {};
    this.barrierFns = new Set();
  }

  resolveType(t) {
    if (t.k === "num") return t;
    if (this.mod.aliases[t.name]) return this.resolveType(this.mod.aliases[t.name]);
    return t;
  }

  // JS expression for the zero value of a type
  zero(t) {
    t = this.resolveType(t);
    if (t.k === "num") throw new Error("a number is not a type");
    switch (t.name) {
      case "u32":
        return "0";
      case "bool":
        return "false";
      case "vec2":
        return "[0,0]";
      case "array": {
        const n = this.count(t.args[1]);
        return `Array.from({length:${n}},()=>${this.zero(t.args[0])})`;
      }
      default:
        if (this.mod.structs[t.name]) return `({${this.mod.structs[t.name].map((m) => `${m.name}:${this.zero(m.type)}`).join(",")}})`;
        throw new Error(`no zero value for type ${t.name}`);
    }
  }
  count(a) {
    if (a.k === "num") return String(a.v);
    return `$o.${a.name}`; // an override identifier
  }

  expr(e) {
    switch (e.k) {
      case "num":
        return String(e.v);
      case "bool":
        return String(e.v);
      case "paren":
        return `(${this.expr(e.e)})`;
      case "id":
        return this.ident(e.name);
      case "un":
        if (e.op === "-") return `$op.sub(0,${this.expr(e.e)})`;
        if (e.op === "!") return `(!${this.expr(e.e)})`;
        if (e.op === "~") return `$op.xor(${this.expr(e.e)},$allones(${this.expr(e.e)}))`;
        if (e.op === "&") return this.expr(e.e); // a pointer is the array itself
        if (e.op === "*") return this.expr(e.e);
        throw new Error(`unary ${e.op}`);
      case "bin": {
        if (e.op === "&&") return `(${this.expr(e.a)}&&${this.expr(e.b)})`;
        if (e.op === "||") return `(${this.expr(e.a)}||${this.expr(e.b)})`;
        if (CMP[e.op]) return `(${this.expr(e.a)}${CMP[e.op]}${this.expr(e.b)})`;
        if (e.op === "<<" || e.op === ">>") {
          let b = e.b;
          while (b.k === "paren") b = b.e;
          if (b.k !== "num" || b.v < 1 || b.v > 31) throw new Error(`shift by something other than a literal 1 .. 31 (${JSON.stringify(b)})`);
        }
        const n = BIN_NAMES[e.op];
        if (!n) throw new Error(`binary ${e.op}`);
        return `$op.${n}(${this.expr(e.a)},${this.expr(e.b)})`;
      }
      case "index":
        return `$getIdx(${this.expr(e.e)},${this.expr(e.i)})`;
      case "member":
        return `$getMember(${this.expr(e.e)},${JSON.stringify(e.name)})`;
      case "ctor":
        return this.ctor(this.resolveType(e.type), e.args);
      case "call":
        return this.call(e);
      default:
        throw new Error(`expression ${e.k}`);
    }
  }

  ident(name) {
    if (name in this.constants || this.mod.overrides.some((o) => o.name === name)) return `$o.${name}`;
    const g = this.mod.globals.find((x) => x.name === name);
    if (g) {
      if (g.space === "workgroup") return `$wg.${name}`;
      if (g.space === "storage" || g.space === "uniform") return `$b.${name}`;
      return `$g.${name}`;
    }
    return mangle(name);
  }

  ctor(t, args) {
    const a = args.map((x) => this.expr(x));
    if (t.name === "vec2") {
      if (a.length === 2) return `[${a[0]},${a[1]}]`;
      if (a.length === 1) return `((x)=>[x,x])(${a[0]})`;
      throw new Error("vec2 constructor");
    }
    if (t.name === "array") return `[${a.join(",")}]`;
    if (this.mod.structs[t.name]) return `({${this.mod.structs[t.name].map((m, i) => `${m.name}:${a[i]}`).join(",")}})`;
    throw new Error(`constructor ${t.name}`);
  }

  call(e) {
    if (e.name === "select") return `((${this.expr(e.args[2])})?(${this.expr(e.args[1])}):(${this.expr(e.args[0])}))`;
    if (e.name === "workgroupBarrier") return "(yield 0)";
    if (this.mod.structs[e.name]) return this.ctor({ name: e.name }, e.args);
    if (this.mod.aliases[e.name]) return this.ctor(this.resolveType({ name: e.name, args: [] }), e.args);
    if (this.mod.fns[e.name]) {
      const call = `${mangle(`fn_${e.name}`)}(${e.args.map((x) => this.expr(x)).join(",")})`;
      return this.barrierFns.has(e.name) ? `(yield* ${call})` : call;
    }
    throw new Error(`unknown function ${e.name}`);
  }

  // does the function (transitively) reach a barrier?
  findBarriers() {
    const direct = {};
    const calls = {};
    const walk = (n, name) => {
      if (Array.isArray(n)) return n.forEach((x) => walk(x, name));
      if (n && typeof n === "object") {
        if (n.k === "call") {
          if (n.name === "workgroupBarrier") direct[name] = true;
          (calls[name] ??= new Set()).add(n.name);
        }
        for (const v of Object.values(n)) walk(v, name);
      }
    };
    for (const f of Object.values(this.mod.fns)) walk(f.body, f.name);
    const hit = new Set(Object.keys(direct));
    for (let changed = true; changed; ) {
      changed = false;
      for (const [f, cs] of Object.entries(calls)) if (!hit.has(f) && [...cs].some((c) => hit.has(c))) hit.add(f), (changed = true);
    }
    this.barrierFns = hit;
  }

  lvalueStore(target, valueJs) {
    if (target.k === "id") return `${this.ident(target.name)}=${valueJs};`;
    if (target.k === "index") return `$setIdx(${this.expr(target.e)},${this.expr(target.i)},${valueJs});`;
    if (target.k === "member") return `$setMember(${this.expr(target.e)},${JSON.stringify(target.name)},${valueJs});`;
    if (target.k === "paren") return this.lvalueStore(target.e, valueJs);
    throw new Error(`assignment target ${target.k}`);
  }

  stmt(s) {
    switch (s.k) {
      case "block":
        return `{${s.body.map((x) => this.stmt(x)).join("")}}`;
      case "decl": {
        const init = s.init ? this.expr(s.init) : this.zero(s.type);
        const val = s.kw === "var" ? `$copy(${init})` : init;
        return `let ${mangle(s.name)}=${val};`;
      }
      case "return":
        return s.e ? `return ${this.expr(s.e)};` : "return;";
      case "if":
        return `if(${this.expr(s.cond)}){${s.then.map((x) => this.stmt(x)).join("")}}${s.els ? `else{${s.els.map((x) => this.stmt(x)).join("")}}` : ""}`;
      case "for": {
        const init = s.init ? this.stmt(s.init).slice(0, -1) : "";
        const cont = s.cont ? this.stmt(s.cont).slice(0, -1) : "";
        return `for(${init};${s.cond ? this.expr(s.cond) : ""};${cont}){${s.body.map((x) => this.stmt(x)).join("")}}`;
      }
      case "continue":
        return "continue;";
      case "break":
        return "break;";
      case "incr":
        return this.lvalueStore(s.target, `$op.add(${this.expr(s.target)},${s.d === 1 ? 1 : "0xffffffff"})`);
      case "assign": {
        let v = this.expr(s.e);
        if (s.op !== "=") v = `$op.${BIN_NAMES[s.op[0]]}(${this.expr(s.target)},${v})`;
        else v = `$copy(${v})`;
        return this.lvalueStore(s.target, v);
      }
      case "callstmt":
        return `${this.expr(s.e)};`;
      default:
        throw new Error(`statement ${s.k}`);
    }
  }

  fn(f) {
    const gen = this.barrierFns.has(f.name) || f.attrs.some((a) => a.name === "compute");
    const params = f.params.map((p) => mangle(p.name)).join(",");
    return `function${gen ? "*" : ""} ${mangle(`fn_${f.name}`)}(${params}){${f.body.map((s) => this.stmt(s)).join("")}}`;
  }
}

/** Evaluates a constant expression (override initialisers, array counts, workgroup sizes) with the given override values. */
function evalConst(e, o) {
  switch (e.k) {
    case "num":
      return e.v;
    case "id":
      if (!(e.name in o)) throw new Error(`unknown constant ${e.name}`);
      return o[e.name];
    case "paren":
      return evalConst(e.e, o);
    case "bin": {
      const a = evalConst(e.a, o);
      const b = evalConst(e.b, o);
      const n = BIN_NAMES[e.op];
      if (!n) throw new Error(`constant operator ${e.op}`);
      return OPS[n](a, b);
    }
    default:
      throw new Error(`constant expression ${e.k}`);
  }
}

// ---------------------------------------------------------------- the module

/**
 * Compiles WGSL source. constants: values for the overrides (the pipeline constants).
 * -> { call(name, ...args), dispatch(entry, groups, bindings, opts), overrides }
 */
export function compileWgsl(source, constants = {}) {
  const mod = new Parser(source).module();
  const o = {};
  for (const ov of mod.overrides) {
    if (ov.name in constants) o[ov.name] = constants[ov.name] >>> 0;
    else if (ov.init) o[ov.name] = evalConst(ov.init, o);
    else throw new Error(`override ${ov.name} has no value`);
  }
  for (const k of Object.keys(constants)) if (!(k in o)) throw new Error(`unknown override ${k}`);
  const gen = new Gen(mod, o);
  gen.findBarriers();
  // module-scope private variables with initialisers
  const privInit = mod.globals
    .filter((g) => g.space === "private")
    .map((g) => `$g.${g.name}=${g.init ? gen.expr(g.init) : gen.zero(g.type)};`)
    .join("");
  const fns = Object.values(mod.fns).map((f) => gen.fn(f)).join("\n");
  const code = `"use strict";
const $op=$rt.OPS,$copy=$rt.copy,$getIdx=$rt.getIdx,$setIdx=$rt.setIdx,$getMember=$rt.getMember,$setMember=$rt.setMember;
const $allones=(a)=>typeof a==="number"?0xffffffff:[0xffffffff,0xffffffff];
let $wg=null,$b=null;
const $g={};
${privInit}
${fns}
return { setWg(w){$wg=w;}, setBindings(b){$b=b;}, fns:{${Object.keys(mod.fns).map((n) => `${JSON.stringify(n)}:${mangle(`fn_${n}`)}`).join(",")}} };`;
  const inst = new Function("$rt", "$o", code)(RT, o);

  const isGen = (n) => mod.fns[n].attrs.some((a) => a.name === "compute") || gen.barrierFns.has(n);

  return {
    overrides: o,
    mod,
    code,
    /** Calls a plain (barrier-free) function with values; u32 as numbers, vec2 as [x, y]. */
    call(name, ...args) {
      if (!mod.fns[name]) throw new Error(`no function ${name}`);
      if (isGen(name)) throw new Error(`${name} is a kernel`);
      return inst.fns[name](...args);
    },
    /**
     * Runs an entry point over `groups` workgroups (x only).
     * bindings: { mem: Uint32Array, pw: Uint32Array, tags: Uint32Array, reftab: Uint32Array, prm: { slotBase, slots, segFrom, segTo } }
     * (mem and tags hold vec2 words, two u32 per element). Returns { races: [...], barriers }.
     */
    dispatch(entry, groups, bindings, { detectRaces = true } = {}) {
      const f = mod.fns[entry];
      if (!f || !f.attrs.some((a) => a.name === "compute")) throw new Error(`${entry} is not a compute entry`);
      const wgs = f.attrs.find((a) => a.name === "workgroup_size").args.map((a) => evalConst(a, o))[0];
      const b = { prm: bindings.prm, pw: bindings.pw, reftab: bindings.reftab };
      if (bindings.mem) b.mem = new Vec2Buf(bindings.mem, "mem");
      if (bindings.tags) b.tags = new Vec2Buf(bindings.tags, "tags");
      inst.setBindings(b);
      const races = [];
      let barriers = 0;
      for (let wg = 0; wg < groups; wg++) {
        let interval = 0;
        let current = 0;
        const touched = new Map(); // "name:index" -> { w: Set, r: Set } within the current interval
        const sched = {
          record(name, kind, i) {
            if (!detectRaces) return;
            const key = `${name}:${i}`;
            let e = touched.get(key);
            if (!e) touched.set(key, (e = { w: new Set(), r: new Set() }));
            (kind === "write" ? e.w : e.r).add(current);
          },
        };
        const flush = () => {
          for (const [key, e] of touched) {
            if (e.w.size && new Set([...e.w, ...e.r]).size > 1) races.push({ workgroup: wg, interval, key, writers: [...e.w], readers: [...e.r] });
          }
          touched.clear();
        };
        const wgVars = {};
        for (const g of mod.globals.filter((x) => x.space === "workgroup")) {
          const t = gen.resolveType(g.type);
          const cnt = t.args[1];
          wgVars[g.name] = new WgArray(g.name, cnt.k === "num" ? cnt.v : o[cnt.name], sched);
        }
        inst.setWg(wgVars);
        const lanes = [];
        for (let lid = 0; lid < wgs; lid++) {
          const args = f.params.map((p) => {
            const bi = p.attrs.find((a) => a.name === "builtin")?.args[0]?.name;
            if (bi === "local_invocation_index") return lid;
            if (bi === "workgroup_id") return [wg, 0, 0];
            if (bi === "global_invocation_id") return [wg * wgs + lid, 0, 0];
            throw new Error(`builtin ${bi}`);
          });
          lanes.push(inst.fns[entry](...args));
        }
        let alive = lanes.map(() => true);
        for (;;) {
          let yielded = 0;
          let finished = 0;
          lanes.forEach((g, lid) => {
            if (!alive[lid]) return;
            current = lid;
            const r = g.next();
            if (r.done) {
              alive[lid] = false;
              finished++;
            } else yielded++;
          });
          if (yielded && finished) throw new Error(`non-uniform barrier in workgroup ${wg}: ${yielded} invocations at a barrier, ${finished} finished`);
          if (yielded && yielded !== alive.filter(Boolean).length) throw new Error("some invocations skipped a barrier");
          if (!yielded) break;
          barriers++;
          flush();
          interval++;
        }
        flush();
      }
      return { races, barriers };
    },
  };
}

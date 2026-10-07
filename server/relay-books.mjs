// Relay balance bookkeeping (docs/design/relay-balance.md §3, contract §2).
// Pure and synchronous: no network, no keys, no clock. All amounts are
// safe-integer satoshis.
//
// The books hold per-account balances and reservations, the credited deposit
// outputs (one record per strictly parsed outpoint key, kept forever so a key is
// never credited twice), the margin account (filled only by margins, sweep costs
// and penalties; it pays housekeeping), two totals and `serviceOut`, the service-fee
// outputs of relayed mining claims (docs/design/mining.md §9, mining-contract.md §9.6),
// each one debited from the account that caused it before the signature. Invariant I2:
//
//   credited + operatorIn − fees − serviceOut − Σ balance − Σ reserved = margin ≥ 0
//   pool unspent coins ≥ Σ balance + Σ reserved + margin
//
// `operator` ({ in, owed }) exists only after an emergency evacuation (relay-balance.md §9): the
// sweep to the operator's cold address is an operator cost, paid from the margin first; what the
// margin cannot pay is the operator's liability (`owed`, counted in `in`), never a user's. Every
// balance stays whole. `owed` drops to 0 once the operator has refunded the pool (operatorPaid).
// Written only once non-zero, so books that never evacuated keep their shape.
//
// An item id sits next to an account id only in `reservations` and `charges`,
// and only until the reservation is released or the charge confirmed or
// refunded. Nothing here ever holds a txid.
//
// Privacy of the files (docs/design/privacy-trace-test.md L2): with `accountKey` (the paid
// relayer passes an HMAC under a key derived from its pool secret) every account is stored
// under that opaque key, never under its account id, so the files do not give the ids from
// which each account's deposit addresses could be derived and looked up on chain. A credit
// whose deposit the pool no longer holds and that is past any reorg (settleCredit) keeps only
// { value, sweepCost, settled }: the outpoint stays so it is never credited twice, but nothing
// says whose it was, so Σ credits of an account − its balance can no longer be formed.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_DEPOSIT_INDEX, RELAY_NETWORKS, parseOutpoint } from "../src/relay-account.mjs";

export const BOOKS_VERSION = 1;

/** .code: "balance_low" | "already_credited" | "bad_key" | "unknown_ref" | "margin_low" | "invalid"; .extra: details. */
export class BooksError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? code);
    this.name = "BooksError";
    this.code = code;
    this.extra = extra;
  }
}

const invalid = (message) => new BooksError("invalid", message);
const HEX64 = /^[0-9a-f]{64}$/;
const REF = /^[A-Za-z0-9_-]{1,64}$/;
const isInt = (v) => Number.isSafeInteger(v);
const isNat = (v) => Number.isSafeInteger(v) && v >= 0;
const isPos = (v) => Number.isSafeInteger(v) && v > 0;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const SETTLED_KEYS = new Set(["value", "sweepCost", "settled", "reversed"]);

/** Margin per carrier: max(marginMinSats, ceil(fee × marginPct / 100)). */
export function marginFor(fee, { marginPct = 10, marginMinSats = 50 } = {}) {
  return Math.max(marginMinSats, Math.ceil((fee * marginPct) / 100));
}

/** What the user pays for a carrier with miner fee `fee`: fee + margin. */
export function costFor(fee, opts) {
  return fee + marginFor(fee, opts);
}

/** The cost of later spending one deposit input at the cap rate: ceil(57.5 × maxFeeRate). */
export function sweepCostFor(maxFeeRate) {
  return Math.ceil(57.5 * maxFeeRate);
}

function checkKeys({ network, poolKey, changeKey, marginPct, marginMinSats }) {
  if (!RELAY_NETWORKS.includes(network)) throw invalid(`unknown network "${network}"`);
  if (typeof poolKey !== "string" || !HEX64.test(poolKey)) throw invalid("poolKey must be 64 lowercase hex characters");
  if (typeof changeKey !== "string" || !HEX64.test(changeKey)) throw invalid("changeKey must be 64 lowercase hex characters");
  if (poolKey === changeKey) throw invalid("the pool key and the change key must differ");
  if (!Number.isInteger(marginPct) || marginPct < 0 || marginPct > 100) throw invalid("marginPct must be an integer 0..100");
  if (!isInt(marginMinSats) || marginMinSats < 1) throw invalid("marginMinSats must be an integer >= 1");
}

/** The canonical outpoint key, or BooksError "bad_key" for any other spelling. */
function canonKey(key) {
  let parsed;
  try {
    parsed = parseOutpoint(key);
  } catch {
    throw new BooksError("bad_key", "not a canonical outpoint key");
  }
  if (parsed.key !== key) throw new BooksError("bad_key", "not a canonical outpoint key");
  return key;
}

function checkId(id) {
  if (typeof id !== "string" || !HEX64.test(id)) throw invalid("an account id is 64 lowercase hex characters");
  return id;
}

function checkRef(ref) {
  if (typeof ref !== "string" || !REF.test(ref)) throw invalid("an item reference is 1 to 64 letters, digits, _ or -");
  return ref;
}

export class RelayBooks {
  #claims = new Set();

  constructor({ network, poolKey, changeKey, marginPct = 10, marginMinSats = 50, accountKey = null }) {
    checkKeys({ network, poolKey, changeKey, marginPct, marginMinSats });
    if (accountKey !== null && typeof accountKey !== "function") throw invalid("accountKey must be a function");
    // The key an account is stored under: accountKey(id) (64 hex characters), or the id itself.
    this.accountKey = accountKey;
    this.network = network;
    this.poolKey = poolKey;
    this.changeKey = changeKey;
    this.marginOpts = Object.freeze({ marginPct, marginMinSats });
    this.accounts = new Map(); // id -> { balance, reserved, nextIndex }
    this.creditMap = new Map(); // key -> { id, n, value, sweepCost, amount, height, reversed? }
    this.reservations = new Map(); // ref -> { id, amount }
    this.charges = new Map(); // ref -> { id, cost, fee, service? } (service only when > 0)
    this.margin = 0;
    this.totals = { credited: 0, fees: 0 };
    // Service-fee outputs paid by carriers of relayed mining claims. Outside `totals` and
    // written only when non-zero, so books that never carried a claim keep their shape.
    this.serviceOut = 0;
    // Evacuation costs the margin could not pay (operator liabilities): `in` in total, `owed` not refunded yet.
    this.operator = { in: 0, owed: 0 };
  }

  /** Books from their persisted shape; throws on another version, network or key, or a malformed record. */
  static restore(json, { network, poolKey, changeKey, marginPct = 10, marginMinSats = 50, accountKey = null }) {
    const data = typeof json === "string" ? JSON.parse(json) : json;
    if (!data || typeof data !== "object") throw invalid("the books are not an object");
    if (data.version !== BOOKS_VERSION) throw invalid(`books version ${data.version} is not ${BOOKS_VERSION}`);
    const books = new RelayBooks({ network, poolKey, changeKey, marginPct, marginMinSats, accountKey });
    if (data.network !== network) throw invalid(`the books are for ${data.network}, not ${network}`);
    if (data.poolKey !== poolKey) throw invalid("the books belong to another pool key");
    if (data.changeKey !== changeKey) throw invalid("the books belong to another change key");
    const obj = (o, what) => {
      if (!o || typeof o !== "object" || Array.isArray(o)) throw invalid(`${what} is not an object`);
      return Object.entries(o);
    };
    // Shapes and types are checked here; the arithmetic is I2's job (checkI2), so a tampered
    // number loads and then fails I2 instead of hiding the books.
    for (const [id, a] of obj(data.accounts, "accounts")) {
      checkId(id);
      if (!a || !isInt(a.balance) || !isInt(a.reserved) || !isNat(a.nextIndex)) throw invalid(`account ${id} is malformed`);
      books.accounts.set(id, { balance: a.balance, reserved: a.reserved, nextIndex: a.nextIndex });
    }
    for (const [key, c] of obj(data.credits, "credits")) {
      canonKey(key);
      if (c?.settled === true) {
        // A settled credit (settleCredit): its value and sweep cost for I2, nothing about its account.
        if (!isInt(c.value) || !isInt(c.sweepCost) || Object.keys(c).some((k) => !SETTLED_KEYS.has(k))) throw invalid(`credit ${key} is malformed`);
        books.creditMap.set(key, { value: c.value, sweepCost: c.sweepCost, settled: true, ...(c.reversed === true ? { reversed: true } : {}) });
        continue;
      }
      if (!c || typeof c.id !== "string" || !HEX64.test(c.id) || !isNat(c.n) || c.n > MAX_DEPOSIT_INDEX
        || !isInt(c.value) || !isInt(c.sweepCost) || !isInt(c.amount) || !(c.height === null || isNat(c.height))) {
        throw invalid(`credit ${key} is malformed`);
      }
      const rec = { id: c.id, n: c.n, value: c.value, sweepCost: c.sweepCost, amount: c.amount, height: c.height };
      if (c.reversed === true) rec.reversed = true;
      books.creditMap.set(key, rec);
    }
    for (const [ref, r] of obj(data.reservations, "reservations")) {
      checkRef(ref);
      if (!r || typeof r.id !== "string" || !HEX64.test(r.id) || !isInt(r.amount)) throw invalid(`reservation ${ref} is malformed`);
      books.reservations.set(ref, { id: r.id, amount: r.amount });
    }
    for (const [ref, c] of obj(data.charges, "charges")) {
      checkRef(ref);
      if (!c || typeof c.id !== "string" || !HEX64.test(c.id) || !isInt(c.cost) || !isInt(c.fee) || !(c.service === undefined || isPos(c.service))) {
        throw invalid(`charge ${ref} is malformed`);
      }
      books.charges.set(ref, { id: c.id, cost: c.cost, fee: c.fee, ...(c.service ? { service: c.service } : {}) });
    }
    if (!isInt(data.margin)) throw invalid("margin is malformed");
    if (!data.totals || !isInt(data.totals.credited) || !isInt(data.totals.fees)) throw invalid("totals are malformed");
    // Books written before mining have no serviceOut: 0.
    const serviceOut = data.serviceOut ?? 0;
    if (!isNat(serviceOut)) throw invalid("serviceOut is malformed");
    // Books that never evacuated have no operator record: nothing in, nothing owed.
    const op = data.operator ?? { in: 0, owed: 0 };
    if (!op || typeof op !== "object" || !isNat(op.in) || !isNat(op.owed) || op.owed > op.in) throw invalid("operator is malformed");
    books.margin = data.margin;
    books.totals = { credited: data.totals.credited, fees: data.totals.fees };
    books.serviceOut = serviceOut;
    books.operator = { in: op.in, owed: op.owed };
    return books;
  }

  /** The persisted shape (version 1; `serviceOut` and `operator` only when non-zero). Never includes a txid. */
  toJSON() {
    const copy = (m) => Object.fromEntries([...m].map(([k, v]) => [k, { ...v }]));
    return {
      version: BOOKS_VERSION,
      network: this.network,
      poolKey: this.poolKey,
      changeKey: this.changeKey,
      accounts: copy(this.accounts),
      credits: copy(this.creditMap),
      reservations: copy(this.reservations),
      charges: copy(this.charges),
      margin: this.margin,
      totals: { ...this.totals },
      ...(this.serviceOut ? { serviceOut: this.serviceOut } : {}),
      ...(this.operator.in ? { operator: { ...this.operator } } : {}),
    };
  }

  /**
   * The same books under a new pool key and change key (a rotation, relay-balance.md §9): every
   * account, credit, reservation, charge and total carried over unchanged. `accountKey` must give
   * the stored keys it gave before (the relayer keeps its books key across a rotation).
   */
  rekeyed({ poolKey, changeKey, accountKey = this.accountKey }) {
    return RelayBooks.restore({ ...this.toJSON(), poolKey, changeKey }, {
      network: this.network, poolKey, changeKey, ...this.marginOpts, accountKey,
    });
  }

  /** The key account `id` is stored under (accountKey(id), or the id itself). */
  keyOf(id) {
    return this.accountKey && typeof id === "string" && HEX64.test(id) ? this.accountKey(id) : id;
  }

  /** { balance, reserved, nextIndex }; zeros for an unknown id (never creates one). */
  account(id) {
    return this.accountByKey(this.keyOf(id));
  }

  /** account() by the stored key (keyOf) rather than the account id. */
  accountByKey(key) {
    const a = this.accounts.get(key);
    return a ? { ...a } : { balance: 0, reserved: 0, nextIndex: 0 };
  }

  #account(id) {
    let a = this.accounts.get(id);
    if (!a) {
      a = { balance: 0, reserved: 0, nextIndex: 0 };
      this.accounts.set(id, a);
    }
    return a;
  }

  /** This account's credits, newest first: [{ outpoint, n, value, amount, height }] (reversed ones left out). */
  credits(id, { limit = 50 } = {}) {
    const out = [];
    const key = this.keyOf(id);
    for (const [outpoint, c] of this.creditMap) {
      if (c.id === key && !c.reversed && !c.settled) out.push({ outpoint, n: c.n, value: c.value, amount: c.amount, height: c.height });
    }
    // Newest first: by height, then by deposit index, then by insertion (later credits last in the map).
    out.reverse();
    const h = (c) => (c.height === null ? Infinity : c.height);
    out.sort((a, b) => h(b) - h(a) || b.n - a.n);
    return out.slice(0, Math.max(0, limit));
  }

  /** The credit record for a canonical outpoint key (a reversed one included), or null. */
  isCredited(key) {
    const c = this.creditMap.get(canonKey(key));
    return c ? { outpoint: key, ...c } : null;
  }

  /** Claims a key in memory before any network call: false if it is credited or already claimed. */
  claim(key) {
    canonKey(key);
    if (this.creditMap.has(key) || this.#claims.has(key)) return false;
    this.#claims.add(key);
    return true;
  }

  unclaim(key) {
    this.#claims.delete(key);
  }

  /**
   * Credits a confirmed deposit output once: balance += value − sweepCost, margin += sweepCost.
   * `byKey`: `id` is already the stored key (keyOf), as a deposit to a retired address passes it
   * (its record kept only that key).
   */
  credit({ key, id, n, value, sweepCost, height = null, byKey = false }) {
    canonKey(key);
    if (this.creditMap.has(key)) throw new BooksError("already_credited", "this deposit was already credited");
    checkId(id);
    if (!byKey) id = checkId(this.keyOf(id));
    if (!isNat(n) || n > MAX_DEPOSIT_INDEX) throw invalid(`deposit index must be an integer 0..${MAX_DEPOSIT_INDEX}`);
    if (!isPos(value)) throw invalid("value must be a positive integer");
    if (!isNat(sweepCost)) throw invalid("sweepCost must be a non-negative integer");
    if (!(height === null || isNat(height))) throw invalid("height must be a non-negative integer");
    const amount = value - sweepCost;
    if (amount <= 0) throw invalid("the deposit does not cover its sweep cost");
    const a = this.#account(id);
    a.balance += amount;
    a.nextIndex = Math.max(a.nextIndex, n + 1);
    this.margin += sweepCost;
    this.totals.credited += value;
    const rec = { id, n, value, sweepCost, amount, height };
    this.creditMap.set(key, rec);
    return { outpoint: key, ...rec };
  }

  /**
   * A credited deposit vanished in a reorg: undo its credit. A balance that would
   * go negative is set to 0 and the deficit is taken from the margin. The record
   * stays, marked reversed, so the key is never credited again.
   */
  reverseCredit(key) {
    canonKey(key);
    const c = this.creditMap.get(key);
    if (!c) throw new BooksError("unknown_ref", "no credit for this outpoint");
    if (c.reversed) return { outpoint: key, ...c };
    if (c.settled) throw new BooksError("unknown_ref", "this credit is settled: past any reorg, it can no longer be reversed");
    const a = this.#account(c.id);
    this.totals.credited -= c.value;
    this.margin -= c.sweepCost;
    a.balance -= c.amount;
    if (a.balance < 0) {
      this.margin += a.balance;
      a.balance = 0;
    }
    c.reversed = true;
    return { outpoint: key, ...c };
  }

  /**
   * L2: forgets whose a credit was, once the pool no longer holds its deposit and no reorg can
   * reverse it (the relayer decides when). The record keeps only { value, sweepCost, settled }
   * (and reversed): enough for I2 and to never credit the outpoint twice. -> whether it changed
   */
  settleCredit(key) {
    canonKey(key);
    const c = this.creditMap.get(key);
    if (!c) throw new BooksError("unknown_ref", "no credit for this outpoint");
    if (c.settled) return false;
    this.creditMap.set(key, { value: c.value, sweepCost: c.sweepCost, settled: true, ...(c.reversed ? { reversed: true } : {}) });
    return true;
  }

  /**
   * Moves `amount` from the account's balance to a reservation for item `ref`. `byKey`: `id` is
   * already the stored key (keyOf), as an item that kept only that key passes it.
   */
  reserve(ref, id, amount, { byKey = false } = {}) {
    checkRef(ref);
    checkId(id);
    if (!byKey) id = checkId(this.keyOf(id));
    if (!isPos(amount)) throw invalid("a reservation must be a positive integer");
    if (this.reservations.has(ref) || this.charges.has(ref)) throw invalid(`item ${ref} already has a reservation or a charge`);
    const balance = this.accountByKey(id).balance;
    if (balance < amount) throw new BooksError("balance_low", "the relay balance does not cover this send", { balance, needed: amount });
    const a = this.#account(id);
    a.balance -= amount;
    a.reserved += amount;
    this.reservations.set(ref, { id, amount });
    return { id, amount };
  }

  /** Returns a reservation to the balance (missed, expired, dropped before signing). */
  release(ref) {
    const r = this.reservations.get(ref);
    if (!r) throw new BooksError("unknown_ref", `no reservation for item ${ref}`);
    const a = this.#account(r.id);
    a.balance += r.amount;
    a.reserved -= r.amount;
    this.reservations.delete(ref);
    return { id: r.id, amount: r.amount };
  }

  /**
   * The exact charge before a signature: cost = fee + service + margin (the margin is on
   * the miner fee only), taken from the item's reservation first, then the available
   * balance; the rest of the reservation goes back. `service` is what a mining claim's
   * carrier pays to its service-fee outputs (0 for a transfer). "balance_low" (nothing
   * changes) when both together fall short. -> { cost, fee, margin }, plus `service` when > 0
   */
  settle(ref, { fee, service = 0 } = {}) {
    const r = this.reservations.get(ref);
    if (!r) throw new BooksError("unknown_ref", `no reservation for item ${ref}`);
    if (!isPos(fee)) throw invalid("a carrier fee must be a positive integer");
    if (!isNat(service)) throw invalid("a service fee must be a non-negative integer");
    const cost = costFor(fee, this.marginOpts) + service;
    const a = this.#account(r.id);
    if (r.amount + a.balance < cost) {
      throw new BooksError("balance_low", "the relay balance does not cover this send", { balance: r.amount + a.balance, needed: cost });
    }
    // min(reservation, cost) comes from the reservation, the rest of the cost from the
    // available balance, and what is left of the reservation goes back to it.
    a.reserved -= r.amount;
    a.balance += r.amount - cost;
    const margin = cost - fee - service;
    this.margin += margin;
    this.totals.fees += fee;
    this.serviceOut += service;
    this.reservations.delete(ref);
    this.charges.set(ref, { id: r.id, cost, fee, ...(service ? { service } : {}) });
    return { cost, fee, margin, ...(service ? { service } : {}) };
  }

  /** The carrier reached the network: the charge's account link is dropped. */
  confirmCharge(ref) {
    const c = this.charges.get(ref);
    if (!c) throw new BooksError("unknown_ref", `no charge for item ${ref}`);
    this.charges.delete(ref);
    return { cost: c.cost, fee: c.fee };
  }

  /** The carrier was never broadcast: undo settle exactly (the cost goes back to the available balance; serviceOut is reversed). */
  refundCharge(ref) {
    const c = this.charges.get(ref);
    if (!c) throw new BooksError("unknown_ref", `no charge for item ${ref}`);
    const service = c.service ?? 0;
    const a = this.#account(c.id);
    a.balance += c.cost;
    this.margin -= c.cost - c.fee - service;
    this.totals.fees -= c.fee;
    this.serviceOut -= service;
    this.charges.delete(ref);
    return { id: c.id, cost: c.cost, fee: c.fee, ...(service ? { service } : {}) };
  }

  /**
   * The margin housekeeping may spend: the margin minus the margins of charges
   * not yet confirmed (a charge refunded later takes its margin back, so that
   * part is never spent first and a refund cannot push the margin below zero).
   */
  availableMargin() {
    let pending = 0;
    for (const c of this.charges.values()) pending += c.cost - c.fee - (c.service ?? 0);
    return this.margin - pending;
  }

  /** A fan-out or merge fee, paid from the available margin only ("margin_low" otherwise). */
  payHousekeeping(fee) {
    if (!isPos(fee)) throw invalid("a housekeeping fee must be a positive integer");
    const available = this.availableMargin();
    if (available < fee) throw new BooksError("margin_low", "the margin account does not cover this housekeeping fee", { margin: available, needed: fee });
    this.margin -= fee;
    this.totals.fees += fee;
    return { fee, margin: this.margin };
  }

  /** Undoes payHousekeeping for a housekeeping transaction that was never signed or broadcast. */
  refundHousekeeping(fee) {
    if (!isPos(fee)) throw invalid("a housekeeping fee must be a positive integer");
    if (fee > this.totals.fees) throw invalid("more fees refunded than were paid");
    this.margin += fee;
    this.totals.fees -= fee;
    return { fee, margin: this.margin };
  }

  /**
   * An evacuation's fee (relay-balance.md §9): an operator cost, never a user's. The available
   * margin pays first; the rest is the operator's liability (operator.in and operator.owed), so no
   * balance or reservation changes. -> { fee, fromMargin, owed }
   */
  payOperatorCost(fee) {
    if (!isPos(fee)) throw invalid("an evacuation fee must be a positive integer");
    const fromMargin = Math.min(fee, Math.max(0, this.availableMargin()));
    const owed = fee - fromMargin;
    this.margin -= fromMargin;
    this.totals.fees += fee;
    this.operator.in += owed;
    this.operator.owed += owed;
    return { fee, fromMargin, owed };
  }

  /**
   * Undoes payOperatorCost for `fee` sats that were not paid after all (a sweep that never reached
   * a block, or a replacement whose cheaper version confirmed): the liability goes first, then the
   * margin gets the rest back. -> { fee, toMargin, owed }
   */
  refundOperatorCost(fee) {
    if (!isPos(fee)) throw invalid("an evacuation fee must be a positive integer");
    if (fee > this.totals.fees) throw invalid("more fees refunded than were paid");
    const fromOwed = Math.min(fee, this.operator.owed);
    this.operator.owed -= fromOwed;
    this.operator.in -= fromOwed;
    this.margin += fee - fromOwed;
    this.totals.fees -= fee;
    return { fee, toMargin: fee - fromOwed, owed: this.operator.owed };
  }

  /** The operator refunded the pool: what it owed is paid (it stays counted in operator.in). -> the sats that were owed */
  operatorPaid() {
    const owed = this.operator.owed;
    this.operator.owed = 0;
    return owed;
  }

  /** Moves min(balance, sats) from the account to the margin (an invalid proof). -> the sats moved */
  penalize(id, sats) {
    if (!isNat(sats)) throw invalid("a penalty must be a non-negative integer");
    const a = this.accounts.get(this.keyOf(id));
    if (!a || a.balance <= 0) return 0;
    const moved = Math.min(a.balance, sats);
    a.balance -= moved;
    this.margin += moved;
    return moved;
  }

  /**
   * A charged carrier never reached the chain after its charge was confirmed, and its input
   * came back to the pool: its fee and the service-fee outputs it paid (`service`, a mining
   * claim's carrier) move to the margin.
   */
  reclaim(sats, { service = 0 } = {}) {
    if (!isNat(sats)) throw invalid("reclaimed sats must be a non-negative integer");
    if (!isNat(service)) throw invalid("reclaimed service sats must be a non-negative integer");
    if (sats > this.totals.fees) throw invalid("more fees reclaimed than were paid");
    if (service > this.serviceOut) throw invalid("more service fees reclaimed than were paid");
    this.totals.fees -= sats;
    this.serviceOut -= service;
    this.margin += sats + service;
    return { sats, margin: this.margin, ...(service ? { service } : {}) };
  }

  /** Σ balance + Σ reserved + margin: what the pool's recorded coins must cover. */
  liabilities() {
    let total = this.margin;
    for (const a of this.accounts.values()) total += a.balance + a.reserved;
    return total;
  }

  /**
   * Invariant I2. ok iff credited equals Σ value over distinct non-reversed
   * credits, credited + operator.in − fees − serviceOut − balances − reserved = margin, margin ≥ 0,
   * serviceOut ≥ 0, every balance and reservation ≥ 0 (and each account's reserved
   * equals its reservations), and poolUnspent ≥ liabilities.
   */
  checkI2({ poolUnspent } = {}) {
    const problems = [];
    const accounts = [...this.accounts.values()];
    const balances = sum(accounts.map((a) => a.balance));
    const reserved = sum(accounts.map((a) => a.reserved));
    const credited = this.totals.credited;
    const fees = this.totals.fees;
    const serviceOut = this.serviceOut;
    const margin = this.margin;
    const operatorIn = this.operator.in;
    const operatorOwed = this.operator.owed;
    const liabilities = balances + reserved + margin;
    const live = [...this.creditMap.values()].filter((c) => !c.reversed);
    const creditSum = sum(live.map((c) => c.value));
    if (credited !== creditSum) problems.push(`credited ${credited} != sum of distinct credited outputs ${creditSum}`);
    for (const [key, c] of this.creditMap) {
      const bad = c.settled ? !(c.value > 0) || c.sweepCost < 0 || c.sweepCost >= c.value : c.amount + c.sweepCost !== c.value || c.amount <= 0 || c.sweepCost < 0;
      if (bad) problems.push(`credit ${key} does not add up`);
    }
    if (credited + operatorIn - fees - serviceOut - balances - reserved !== margin) {
      // The pre-mining wording while no service fee was ever paid; operatorIn only after an evacuation.
      const op = operatorIn ? ` + operatorIn ${operatorIn}` : "";
      problems.push(serviceOut
        ? `credited ${credited}${op} - fees ${fees} - serviceOut ${serviceOut} - balances ${balances} - reserved ${reserved} != margin ${margin}`
        : `credited ${credited}${op} - fees ${fees} - balances ${balances} - reserved ${reserved} != margin ${margin}`);
    }
    if (operatorOwed < 0 || operatorOwed > operatorIn) problems.push(`operator owed ${operatorOwed} is outside 0..${operatorIn}`);
    if (margin < 0) problems.push(`margin ${margin} < 0`);
    if (fees < 0) problems.push(`fees ${fees} < 0`);
    if (serviceOut < 0) problems.push(`serviceOut ${serviceOut} < 0`);
    const held = new Map();
    for (const [ref, r] of this.reservations) {
      if (r.amount < 0) problems.push(`reservation ${ref} is negative`);
      held.set(r.id, (held.get(r.id) ?? 0) + r.amount);
    }
    for (const [id, a] of this.accounts) {
      if (a.balance < 0) problems.push(`account ${id.slice(0, 8)} balance ${a.balance} < 0`);
      if (a.reserved < 0) problems.push(`account ${id.slice(0, 8)} reserved ${a.reserved} < 0`);
      if (a.reserved !== (held.get(id) ?? 0)) problems.push(`account ${id.slice(0, 8)} reserved ${a.reserved} != its reservations ${held.get(id) ?? 0}`);
    }
    for (const id of held.keys()) if (!this.accounts.has(id)) problems.push(`reservation for unknown account ${id.slice(0, 8)}`);
    if (!isInt(poolUnspent)) problems.push("pool unspent coins unknown");
    else if (poolUnspent < liabilities) problems.push(`pool unspent ${poolUnspent} < liabilities ${liabilities}`);
    const values = [credited, fees, serviceOut, balances, reserved, margin, liabilities, operatorIn, operatorOwed];
    if (!values.every(isInt)) problems.push("a total is not a safe integer");
    return { ok: problems.length === 0, problems, credited, fees, serviceOut, balances, reserved, margin, liabilities, poolUnspent, operatorIn, operatorOwed };
  }
}

/** Atomic, durable write: tmp file, fsync, rename, then fsync the file (Windows) or its directory. */
function writeDurable(path, text) {
  const tmp = path + ".tmp";
  const flush = (target, flags, data) => {
    const fd = openSync(target, flags);
    try {
      if (data) writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  flush(tmp, "w", text);
  renameSync(tmp, path);
  if (process.platform === "win32") flush(path, "r+");
  else flush(dirname(path), "r");
}

/** Durable write of JSON.stringify(books.toJSON()). */
export function saveBooks(path, books) {
  mkdirSync(dirname(path), { recursive: true });
  writeDurable(path, JSON.stringify(books.toJSON()));
}

/** RelayBooks.restore of the file; a missing file gives new books. */
export function loadBooks(path, keys) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return new RelayBooks(keys);
    throw e;
  }
  return RelayBooks.restore(JSON.parse(text), keys);
}

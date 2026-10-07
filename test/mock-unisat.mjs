// Stand-in for the Unisat extension (window.unisat). Offline it records
// sendBitcoin calls; given an Esplora `api` it behaves like the real wallet:
// funds from its own address, adds the memo as OP_RETURN, signs and broadcasts.
// Used by tests and signet checks only, never by the app.
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1";
import { NETWORK } from "../src/btc/funding.mjs";
import { opReturnScript } from "../src/envelope.mjs";
import { randomBytes, unhex } from "../src/bytes.mjs";

export class MockUnisat {
  constructor({ type = "p2tr", key = randomBytes(32), api = null } = {}) {
    this.key = key;
    this.api = api;
    const pub = secp256k1.getPublicKey(key, true);
    this.pay = type === "p2tr" ? btc.p2tr(pub.slice(1), undefined, NETWORK) : btc.p2wpkh(pub, NETWORK);
    this.type = type;
    this.address = this.pay.address;
    this.chain = "BITCOIN_MAINNET";
    this.sent = [];
  }
  async getChain() { return { enum: this.chain }; }
  async switchChain(chain) { this.chain = chain; return { enum: chain }; }
  async requestAccounts() { return [this.address]; }
  async getAccounts() { return [this.address]; }
  async getBalance() {
    const total = this.api ? (await this.api.utxos(this.address)).reduce((s, u) => s + u.value, 0) : 0;
    return { confirmed: total, unconfirmed: 0, total };
  }
  async sendBitcoin(to, satoshis, { feeRate = 1, memo } = {}) {
    if (this.chain !== "BITCOIN_SIGNET") throw new Error("mock: wrong chain");
    this.sent.push({ to, satoshis, feeRate, memo });
    if (!this.api) return "00".repeat(32);

    const outputs = [{ script: btc.OutScript.encode(btc.Address(NETWORK).decode(to)), amount: BigInt(satoshis) }];
    if (memo) outputs.push({ script: opReturnScript(unhex(memo)), amount: 0n });
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    let total = 0n;
    const need = outputs.reduce((s, o) => s + o.amount, 0n);
    const fee = () => BigInt(Math.ceil(feeRate * (11 + 68 * tx.inputsLength + 43 + outputs.reduce((s, o) => s + 9 + o.script.length, 0))));
    for (const u of (await this.api.utxos(this.address)).sort((a, b) => b.value - a.value)) {
      tx.addInput({
        txid: u.txid, index: u.vout,
        witnessUtxo: { script: this.pay.script, amount: BigInt(u.value) },
        ...(this.type === "p2tr" ? { tapInternalKey: this.pay.tapInternalKey } : {}),
      });
      total += BigInt(u.value);
      if (total >= need + fee()) break;
    }
    if (total < need + fee()) throw new Error("mock: insufficient balance");
    outputs.forEach((o) => tx.addOutput(o));
    tx.addOutput({ script: this.pay.script, amount: total - need - fee() });
    tx.sign(this.key);
    tx.finalize();
    return this.api.broadcast(tx.hex);
  }
  on() {}
}

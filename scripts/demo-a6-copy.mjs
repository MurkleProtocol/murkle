// Signet-only demo for audit finding A-6: rebroadcast someone's pending MINT
// envelope in a different transaction (own first input, treasury paid).
// Expected indexer verdict for the copy: "MINT not bound to this transaction".
//
//   node scripts/demo-a6-copy.mjs <payer-wallet> <original-mint-txid>
// Reads the CLI's cli-state.json (else state.json) and wallets/<payer-wallet>.json from $MURKLE_DATA_DIR
// (default data/signet/), as the CLI does.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRawTx } from "../src/btc/block.mjs";
import { Esplora } from "../src/btc/esplora.mjs";
import { btcAccount, buildCarrierTx } from "../src/btc/funding.mjs";
import { outpointOf } from "../src/bytes.mjs";
import { decodeEnvelope, findEnvelope } from "../src/envelope.mjs";
import { loadIndexer, loadPinnedVkey } from "../src/store-node.mjs";
import { EXPLORER, env as envVar } from "../src/params.mjs";

const [payer, originalTxid] = process.argv.slice(2);
if (!originalTxid) throw new Error("usage: demo-a6-copy.mjs <payer-wallet> <original-mint-txid>");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = envVar("DATA_DIR") ?? join(ROOT, "data", "signet");
const api = new Esplora();
const vkey = loadPinnedVkey(join(ROOT, "build/dev/verification_key.json"));
// The CLI's own snapshot (bin/murkle.mjs), else the one in state.json; this script never saves it.
const statePath = ["cli-state.json", "state.json"].map((n) => join(DATA, n)).find((p) => existsSync(p)) ?? join(DATA, "cli-state.json");
const idx = await loadIndexer(statePath, { vkey, api });
const btcKey = Buffer.from(JSON.parse(readFileSync(join(DATA, "wallets", `${payer}.json`), "utf8")).btcKey, "hex");

const { outputs } = parseRawTx(await api.rawTx(originalTxid), originalTxid);
const envelope = findEnvelope({ outputs });
const env = decodeEnvelope(envelope);
const asset = idx.assets.get(env.publicAsset);
console.log(`copying MINT of ${asset.ticker}, bound to ${Buffer.from(env.bindOutpoint).toString("hex").slice(0, 16)}…`);

// Any UTXO of ours that is neither the bound outpoint nor created by the original tx.
const bound = Buffer.from(env.bindOutpoint);
const utxos = await api.utxos(btcAccount(btcKey).address);
const first = utxos.find((u) => u.txid !== originalTxid && !Buffer.from(outpointOf(u.txid, u.vout)).equals(bound));
if (!first) throw new Error("no independent UTXO to fund the copy");

const tx = await buildCarrierTx({ api, btcKey, envelope, outputs: [{ script: asset.treasury, amount: asset.priceSats }], firstInput: first });
const txid = await api.broadcast(tx.hex);
console.log(`copy broadcast: ${txid} (first input ${first.txid}:${first.vout})`);
console.log(`  ${EXPLORER}/tx/${txid}`);
if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();

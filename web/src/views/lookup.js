/**
 * /nullifier/:hex and /commitment/:hex (visual.md section 9): one template that answers
 * Spent / Unspent or Included, with the transaction, leaf index and seal pill.
 *
 * Privacy: the value in the URL is never sent to our indexer. This page downloads the full
 * public lists (every wallet downloads them anyway) and searches them here. The spending
 * transaction of a nullifier is only known from your own replay (Verify the Pool), because
 * the indexer's log deliberately doesn't index nullifiers.
 */
import "../verify/verify.css";
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { prov } from "../ui/prov.js";
import { int, hash, heightText } from "../ui/format.js";
import { sealPill } from "../ui/seal.js";
import { INDEXER_HREF } from "../ui/indexer.js";
import { button, kv, tag } from "../ui/components.js";
import { setTitle } from "../router.js";
import { commitmentsAll, nullifiersAll, outputsAll, verdictOf } from "../verify/pool-data.js";
import { loadReplay, replaySpentBy } from "../verify/replay.js";
import { mySession } from "../verify/my-view.js";

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function parse(hex) {
  const s = String(hex ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (/^[0-9a-f]{1,64}$/.test(s)) {
    const v = BigInt("0x" + s);
    return v < FIELD ? v : null;
  }
  if (/^\d{1,78}$/.test(s)) {
    const v = BigInt(s);
    return v < FIELD ? v : null;
  }
  return null;
}

const hex64 = (v) => v.toString(16).padStart(64, "0");

export function render(root, params) {
  const kind = params.kind === "commitment" ? "commitment" : "nullifier";
  const value = parse(params.hex);
  const title = kind === "nullifier" ? "Nullifier" : "Commitment";
  setTitle(`${title} ${value !== null ? hex64(value).slice(0, 8) : ""}`.trim());
  if (value === null) {
    root.innerHTML = html`<div class="container section"><section class="panel panel--certified placeholder" role="alert">
      <div class="eyebrow">${title.toUpperCase()} LOOKUP</div>
      <h1 class="h1-app">That isn't a field element.</h1>
      <p>A ${kind} is a number below the BN254 field order, written as 64 hexadecimal characters. Check the link and try again.</p>
      ${button({ label: "Go to Verify", href: "/verify", kind: "secondary" })}
    </section></div>`;
    return;
  }

  root.innerHTML = html`<div class="container section lk">
    <header class="page-head">
      <div>
        <div class="eyebrow">${icon(kind, { size: 14 })} ${title.toUpperCase()}</div>
        <h1 class="h1-app lk-title" data-headline>Looking it up…</h1>
        <p class="lead" data-lead>${kind === "nullifier"
          ? "A nullifier is a public spend tag. It shows that some note was spent, never which one or by whom."
          : "A commitment is a new note's sealed fingerprint. It shows that a note exists, never its token, amount or owner."}</p>
      </div>
    </header>
    <section class="panel panel--certified lk-panel">
      ${kv([
        ["Hex", hash(hex64(value), { head: 12, tail: 12, label: `Copy ${kind}` })],
        ["Decimal", html`<span class="mono lk-dec">${value.toString()}</span>`],
      ])}
      <div class="lk-answer" data-answer aria-live="polite"><span class="skel" style="width:60%;height:18px"></span></div>
    </section>
    <p class="caption t-3 lk-note">${icon("lock", { size: 14 })} This value was not sent to our indexer: your browser downloaded the full public ${kind === "nullifier" ? "nullifier" : "commitment"} list and searched it here.</p>
  </div>`;

  let alive = true;
  const answer = root.querySelector("[data-answer]");
  const headline = root.querySelector("[data-headline]");
  const paint = (h, body) => {
    if (!alive) return;
    headline.textContent = h;
    answer.innerHTML = body;
  };

  (kind === "nullifier" ? nullifierAnswer(value) : commitmentAnswer(value))
    .then(({ headline: h, body }) => paint(h, body))
    .catch((e) => paint("Couldn't look it up.", html`<p class="small t-danger">${e.message}</p><p class="caption t-3">The public lists come from our indexer. Try again in a minute, or <a href="${INDEXER_HREF}" data-link>switch to your own indexer</a>.</p>`));

  return () => {
    alive = false;
  };
}

async function txLine(txid) {
  const v = await verdictOf(txid).catch(() => null);
  const seal = v ? { state: v.ok ? "accepted" : "rejected", height: v.height, reason: v.reason } : null;
  return html`<div class="lk-tx">
    ${hash(txid, { href: `/tx/${txid}`, head: 10, tail: 10, label: "Copy txid" })}
    ${seal ? sealPill(seal) : ""}
    ${button({ label: "Verify in my browser", href: `/tx/${txid}`, kind: "neutral", size: "sm", icon: "proof" })}
  </div>`;
}

async function nullifierAnswer(value) {
  const dec = value.toString();
  const [set, state] = await Promise.all([nullifiersAll({ fresh: true }), commitmentsAll()]);
  const s = mySession();
  const ownNote = (s?.wallet?.notes ?? []).find((n) => String(n.nullifier) === dec) ?? null;
  const own = ownNote ? html`<p class="small lk-own">${icon("eye", { size: 14 })} One of your notes. ${tag("decrypted in this browser", "proof")}</p>` : "";
  if (!set.has(dec)) {
    return {
      headline: "Unspent.",
      body: html`<p class="lk-verdict">${tag("UNSPENT", "neutral")} ${prov("IDX")}</p>
        <p class="small t-2">No accepted transaction has published this nullifier, as of ${heightText(state.height)}. A nullifier appears on Bitcoin only when its note is spent; until then, only the note's owner can compute it.</p>${own}`,
    };
  }
  const txid = await replaySpentBy(dec).catch(() => null);
  const replay = await loadReplay().catch(() => null);
  const where = txid
    ? html`<div class="lk-row"><span class="eyebrow">SPENT IN ${prov("YOU")}</span>${await txLine(txid)}<p class="caption t-3">Found in your own replay of raw Bitcoin blocks (up to ${heightText(replay?.snapshot?.height)}).</p></div>`
    : html`<p class="small t-2">Our indexer's log deliberately doesn't say which transaction published a nullifier, so a lookup can't reveal interest in one. ${replay ? "Your saved replay doesn't cover it yet: run Verify the Pool again to catch up." : "Run Verify the Pool once and this page will find the transaction from raw Bitcoin blocks."}</p>
       ${button({ label: "Verify the Pool", href: "/verify#pool", kind: "secondary", size: "sm" })}`;
  return {
    headline: "Spent.",
    body: html`<p class="lk-verdict">${tag("SPENT", "btc")} ${prov("IDX")}</p>
      <p class="small t-2">This nullifier is in the pool's spent set, as of ${heightText(state.height)}. Its note can never be spent again.</p>${where}${own}`,
  };
}

async function commitmentAnswer(value) {
  const { rows, height } = await commitmentsAll({ fresh: true });
  let leaf = -1;
  for (let i = 0; i < rows.length; i++) {
    if (BigInt(rows[i][0]) === value) {
      leaf = i;
      break;
    }
  }
  if (leaf < 0) {
    return {
      headline: "Not in the pool.",
      body: html`<p class="lk-verdict">${tag("NOT FOUND", "neutral")} ${prov("IDX")}</p><p class="small t-2">No accepted output has this commitment, as of ${heightText(height)}. If it was just broadcast, wait for a block and check again.</p>`,
    };
  }
  // The transaction: from your replay if you have one, else from the bulk output list.
  let txid = null;
  let source = "IDX";
  const replay = await loadReplay().catch(() => null);
  const fromReplay = replay?.snapshot?.outputs?.[leaf];
  if (fromReplay && BigInt(fromReplay.commitment) === value) {
    txid = fromReplay.txid;
    source = "YOU";
  } else {
    const s = mySession();
    const local = s?.view?.outputs?.[leaf];
    const outs = local ? null : await outputsAll().catch(() => null);
    txid = local?.txid ?? outs?.[leaf]?.txid ?? null;
  }
  const s = mySession();
  const mine = (s?.wallet?.notes ?? []).some((n) => n.leafIndex === leaf);
  return {
    headline: "Included.",
    body: html`<p class="lk-verdict">${tag("IN THE POOL", "proof")} ${prov("IDX")}</p>
      ${kv([
        ["Leaf index", html`<span class="mono">${int(leaf)}</span> of ${int(rows.length)}`],
        ["Block", html`<span class="mono t-btc">${heightText(rows[leaf][1])}</span>`],
      ], { compact: true })}
      ${txid ? html`<div class="lk-row"><span class="eyebrow">CREATED IN ${prov(source)}</span>${await txLine(txid)}</div>` : html`<p class="small t-2">The output list couldn't be loaded, so the transaction that created this note isn't shown. Try again in a minute.</p>`}
      ${mine ? html`<p class="small lk-own">${icon("eye", { size: 14 })} This note is yours. ${tag("decrypted in this browser", "proof")}</p>` : ""}
      <p class="caption t-3">Open the transaction to rebuild the note tree and check its proof in your browser.</p>`,
  };
}

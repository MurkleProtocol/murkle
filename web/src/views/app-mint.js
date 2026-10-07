// /app/mint: tokens that are mintable now, payer readiness, a Disclosure Preview
// and the proving sheet. A mint is a public purchase: the token, the amount and
// the paying Bitcoin address are visible. Privacy starts with the first private send.
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { int, sats, heightText, eta } from "../ui/format.js";
import { button, panel, payerCard, progress, statusPill, kv, disclosure, empty } from "../ui/components.js";
import { prov } from "../ui/prov.js";
import { sigil } from "../ui/sigil.js";
import { LINK_TEXT } from "../ui/meter.js";
import { chainWritesBlocked } from "../ui/status.js";
import { openSheet } from "../ui/sheet.js";
import { toast } from "../ui/toast.js";
import { UNISAT_SIGNET_NOTICE } from "../payers.js";
import { BTC_WORD } from "../config.js";
import { mintPayment } from "../session.js";
import { withWallet, pageHead, wireStreamer, liveSession, amountHTML, amountText, btcHTML, btcText, satsHTML, callout, provingSheet } from "./app-shared.js";
import { openDeposit } from "./deposit.js";

export const MINT_STEPS = (payerKind) => [
  { id: "keys", label: "Load proving key" },
  { id: "sync", label: "Sync pool and match root", prov: "IDX" },
  { id: "payer", label: payerKind === "unisat" ? "Bind the mint to your Unisat address" : "Pick and bind your coin (A-6)" },
  { id: "prove", label: "Build witness and prove (Groth16)" },
  { id: "verify", label: "Self-verify proof locally", prov: "YOU" },
  { id: "sign", label: payerKind === "unisat" ? "Confirm in Unisat" : "Sign with built-in key" },
  { id: "broadcast", label: "Broadcast, then in mempool", prov: "BTC" },
];

const SPILL = { live: "open", upcoming: "upcoming", "sold-out": "soldout", ended: "ended" };

export function payerCards(s, name = "mint-payer") {
  const unisat = s.payerPref === "unisat";
  return html`${payerCard({ value: "relay", name, title: "Relayer", status: "not for mints", link: { level: 1, text: LINK_TEXT.mint }, disabled: true, reason: "Mints are paid from your Bitcoin address." })}
    ${payerCard({
      value: "local", name, title: "Built-in key", status: s.btc ? html`${satsHTML(s.btc.sats)} ${prov("BTC")}` : "balance not checked", checked: !unisat,
      fee: html`${btcHTML(s.localPayer.address)}`, link: { level: 2, text: LINK_TEXT.builtin },
    })}
    ${payerCard({
      value: "unisat", name, title: "Unisat", status: s.unisat ? "connected" : "not connected", checked: unisat,
      fee: s.unisat ? btcHTML(s.unisat.address) : null, link: { level: 1, text: LINK_TEXT.unisat(s.unisat ? btcText(s.unisat.address) : "address") },
      warning: UNISAT_SIGNET_NOTICE,
    })}`;
}

/** What one mint pays the treasury; a price below the dust limit is paid at that limit. */
export function paidHTML(a) {
  const { paid, raised } = mintPayment(a);
  return html`<span class="mono t-btc">${sats(paid)}</span>${raised ? html` <span class="caption t-3">raised to the dust limit (price ${sats(a.priceSats)})</span>` : ""}`;
}

const mintLabel = (a) => {
  const { paid } = mintPayment(a);
  return `Mint · ${paid > 0n ? sats(paid) + " + fee" : "fee only"}`;
};

function readiness(s) {
  if (s.payerPref === "unisat") return s.unisat ? null : "Connect Unisat below, or pick the built-in key.";
  if (s.btc && s.btc.sats === 0) return `Add ${BTC_WORD} to your built-in key first.`;
  return null;
}

/** The built-in key pays and was checked empty: say so up top, with the way to fix it. */
export function emptyKeyNotice(s) {
  if (s.payerPref === "unisat" || !s.btc || s.btc.sats !== 0) return "";
  return html`<div class="callout callout--warn fund-callout">${icon("warn", { size: 16 })}<div><b>Your built-in key has no BTC.</b> Mints are paid from it, so add ${BTC_WORD} first. It pays the private sends you pay yourself too.</div>${button({ label: "Add BTC", kind: "secondary", size: "sm", icon: "plus", action: "add-btc" })}</div>`;
}

function card(s, a, picked) {
  const blocked = chainWritesBlocked();
  const notReady = readiness(s);
  const reason = blocked ?? notReady ?? (s.view ? null : "Syncing the pool…");
  return panel({
    cls: `lcard${picked ? " is-picked" : ""}`,
    body: html`<div class="lcard-top">${sigil(a.id, { size: 40 })}<a class="ticker" href="/t/${a.ticker}" data-link>${a.ticker}</a>${statusPill(SPILL[a.status] ?? "ended")}</div>
      <div class="lcard-meta">Launched ${heightText(a.deployHeight)}${a.endHeight ? ` · ends ${heightText(a.endHeight)}` : ""}</div>
      ${progress({ value: a.minted, max: a.mintCap })}
      ${kv([["Per mint", html`${amountHTML(a.mintAmount, a.divisibility, a.ticker)}`], ["Price", paidHTML(a)], ["Your balance", amountHTML(a.balance, a.divisibility)]], { compact: true })}
      ${button({ label: mintLabel(a), kind: "btc", action: "mint", attrs: { "data-id": a.id }, disabled: Boolean(reason), reason, block: true, icon: "mint" })}`,
  });
}

export function mintView(root, s, query) {
  const want = query?.get("t")?.toUpperCase() ?? null;
  let busy = false;

  const paint = () => {
    const list = s.assets();
    const live = list.filter((a) => a.status === "live").sort((x, y) => (x.ticker === want ? -1 : y.ticker === want ? 1 : (y.mints144 ?? 0) - (x.mints144 ?? 0)));
    const upcoming = list.filter((a) => a.status === "upcoming");
    const wanted = want ? list.find((a) => a.ticker === want) : null;
    root.innerHTML = html`<div class="wl">
      ${pageHead({ eyebrow: "MINT", title: "Mint a token", lead: "A mint is a public purchase (token, amount and payer are visible). Privacy starts with your first private send.", actions: button({ label: "All mints", href: "/mints", kind: "ghost", size: "sm" }) })}
      ${emptyKeyNotice(s)}
      ${wanted && wanted.status !== "live" ? callout(html`<b>${wanted.ticker} isn't mintable right now</b> (${String(wanted.status).replace("-", " ")}${wanted.status === "upcoming" && s.view ? `, opens in ${int(wanted.startHeight - s.view.height - 1)} blocks, ${eta(wanted.startHeight - s.view.height - 1)}` : ""}).`, "info") : ""}
      <div class="wl-cols">
        <div class="stack stack--l">
          ${!s.view ? html`<div class="skel" style="height:220px;width:100%"></div>` : live.length ? html`<div class="mint-grid">${live.map((a) => card(s, a, a.ticker === want))}</div>` : empty({ text: "No open mints right now. Be first: write a token to Bitcoin.", action: { label: "Launch a token", href: "/app/launch" } })}
          ${upcoming.length ? panel({ eyebrow: "UPCOMING", body: kv(upcoming.map((a) => [html`<span class="tok">${sigil(a.id, { size: 24 })}<span class="ticker">${a.ticker}</span></span>`, s.view ? `opens in ${int(a.startHeight - s.view.height - 1)} blocks, ${eta(a.startHeight - s.view.height - 1)}` : heightText(a.startHeight)])) }) : ""}
        </div>
        <aside class="stack stack--l preview-sticky">
          ${panel({
            eyebrow: "PAID BY",
            title: "Mint fee payer",
            body: html`<div class="payers" data-payers>${payerCards(s)}</div>
              <div class="inline-actions" style="margin-top:12px">${s.payerPref === "unisat" ? (s.unisat ? "" : button({ label: "Connect Unisat", kind: "secondary", size: "sm", action: "unisat" })) : html`${button({ label: "Add BTC", kind: "secondary", size: "sm", icon: "plus", action: "add-btc" })}${button({ label: "Check BTC", kind: "ghost", size: "sm", icon: "refresh", action: "check-btc" })}`}</div>
              <p class="caption t-3" style="margin-top:8px">Each mint is bound to the coin or address that pays it (audit A-6), so a copy of your envelope from the mempool gets nothing.</p>`,
          })}
        </aside>
      </div>
    </div>`;
  };

  async function startMint(a) {
    if (busy) return;
    const payerKind = s.payerPref;
    const payerAddr = payerKind === "unisat" ? s.unisat?.address : s.localPayer.address;
    const confirm = openSheet({
      title: `Mint ${a.ticker}`,
      eyebrow: "REVIEW",
      body: html`<div class="stack">${disclosure({
        op: "Mint",
        publicRows: [
          ["Operation", "mint"],
          ["Token", a.ticker],
          ["Amount", amountHTML(a.mintAmount, a.divisibility, a.ticker)],
          ["To treasury", paidHTML(a)],
          ["Paid by", btcHTML(payerAddr, { copy: false })],
          ["Bitcoin fee", "set by the market (about 600 vB)"],
        ],
        hidden: ["Which shielded address receives the note", "What you do with it next"],
        note: LINK_TEXT.mint,
      })}
      ${button({ label: mintLabel(a), kind: "btc", size: "lg", action: "go", block: true, icon: "mint" })}</div>`,
    });
    confirm.el.querySelector("[data-action=go]").addEventListener("click", async () => {
      confirm.close();
      busy = true;
      const sheet = provingSheet({ title: `Minting ${a.ticker}`, steps: MINT_STEPS(payerKind) });
      try {
        const entry = await s.mint(a, { onStep: sheet.onStep });
        sheet.done({
          body: callout(html`<b>In the mempool.</b> Your private note appears once a block includes the mint and the indexer accepts it.`, "proof"),
          actions: button({ label: "View receipt", href: `/tx/${entry.txid}`, kind: "secondary" }),
        });
        toast({ kind: "success", title: `Mint of ${a.ticker} broadcast.`, body: `${amountText(a.mintAmount, a.divisibility, a.ticker)} arrives as a private note after the next block.`, action: { label: "Activity", href: "/app/activity" } });
      } catch (err) {
        sheet.fail(err); // lack of BTC on the built-in key: the sheet offers Add BTC
      } finally {
        busy = false;
        paint();
      }
    });
  }

  const onClick = async (e) => {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    const act = b.dataset.action;
    try {
      if (act === "mint") {
        const a = s.assets().find((x) => x.id === b.dataset.id);
        if (a) await startMint(a);
      } else if (act === "add-btc") {
        openDeposit(s);
      } else if (act === "check-btc") {
        b.disabled = true;
        await s.checkBtc();
      } else if (act === "unisat") {
        await s.connectUnisat();
        paint();
      }
    } catch (err) {
      toast({ kind: "danger", title: "That didn't work.", body: err.message });
      paint();
    }
  };
  const onChange = (e) => {
    if (e.target.name !== "mint-payer") return;
    s.payerPref = e.target.value;
    paint();
  };
  paint();
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  const offLive = liveSession(s, () => !busy && paint());
  const offStreamer = wireStreamer(root, paint);
  return () => {
    root.removeEventListener("click", onClick);
    root.removeEventListener("change", onChange);
    offLive();
    offStreamer();
  };
}

export function render(root, params, query) {
  return withWallet(root, (s) => mintView(root, s, query));
}

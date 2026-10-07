// The ceremony contribution page (web/ceremony.html, served at /ceremony). docs/CEREMONY.md.
//
// Flow: read the coordinator status -> join the queue with a public name -> wait (this tab polls,
// which is the heartbeat) -> when the slot is ours: download the latest key (sha256 checked),
// contribute in a Web Worker with fresh entropy, upload -> the coordinator verifies it and answers
// with a receipt -> the receipt and a transcript check are shown.
//
// The queue pass and the entropy live only in this module's memory and in the worker message.
// Nothing is written to storage; closing the tab forgets both.
import "@fontsource/instrument-sans/latin-400.css";
import "@fontsource/instrument-sans/latin-500.css";
import "@fontsource/instrument-sans/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "./ceremony.css";
// First after the styles: inside a frame it shows a notice and stops here (audit V2-10).
import "../frame-guard.js";

import { CeremonyClient, CeremonyError, sha256Hex } from "./client.js";
import { freshEntropy } from "./core.js";
import { checkReceipt, findContribution, normalizeHash, ownReceipt, receiptText } from "./receipt.js";

const client = new CeremonyClient("");
const $ = (id) => document.getElementById(id);

/** Element builder: el("p", { class: "x" }, "text", child). Text is always set as text. */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const mb = (n) => `${(n / 2 ** 20).toFixed(1)} MB`;
const short = (h) => (h ? `${h.slice(0, 16)}…${h.slice(-8)}` : "none yet");
const replace = (node, ...children) => {
  node.replaceChildren(...children.flat().filter(Boolean));
  return node;
};

export const ERROR_TEXT = {
  bad_name: "Use 1 to 64 plain characters (letters, digits, spaces and punctuation).",
  name_taken: "That name is already in the queue or in the transcript. Pick another one.",
  rate_limited: "Too many joins from your network in the last hour. Try again later.",
  queue_full: "The queue is full right now. Try again later.",
  closed: "The ceremony is closed: no more contributions are accepted.",
  paused: "The coordinator has paused the queue. Try again later.",
  low_disk: "The coordinator is low on disk space and does not take new contributors right now.",
  not_your_turn: "It is not your turn.",
  slot_expired: "Your slot expired before the upload started. Join again to get a new one.",
  too_large: "The upload is larger than the coordinator accepts.",
  turn_expired: "Your place in the queue expired (this tab stopped polling, or the slot timed out). Join again.",
  turn_unknown: "The coordinator does not know this queue place any more. Join again.",
  turn_done: "This queue place has already contributed.",
  bad_download: "The downloaded key does not match the hash the coordinator announced. Nothing was contributed.",
  network: "The coordinator could not be reached.",
};
const explain = (e) => {
  if (e instanceof CeremonyError) {
    if (e.code === "rejected") return `The coordinator rejected the upload: ${e.detail?.reason ?? "it did not verify"}.`;
    return ERROR_TEXT[e.code] ?? `The coordinator answered ${e.code}.`;
  }
  return e?.message ?? String(e);
};

/* ------------------------------------------------------------------ status */

let status = null;
async function refreshStatus() {
  try {
    status = await client.status();
  } catch (e) {
    replace($("status"), el("p", { class: "cer-warn" }, `Status unavailable: ${explain(e)}`));
    return;
  }
  const s = status;
  const phaseText = { open: "Open", paused: "Paused", closed: "Closed", finalized: "Finalized" }[s.phase] ?? s.phase;
  replace(
    $("status"),
    el("dl", { class: "cer-facts" },
      el("dt", {}, "Ceremony"), el("dd", { class: "mono" }, s.id, s.pinned ? "" : " (rehearsal: not the pinned circuit)"),
      el("dt", {}, "Phase"), el("dd", {}, el("span", { class: `cer-chip cer-chip--${s.phase}` }, phaseText)),
      el("dt", {}, "Contributions"), el("dd", { class: "mono" }, String(s.contributions)),
      el("dt", {}, "Waiting"), el("dd", { class: "mono" }, `${s.waiting}${s.slot.active ? " + 1 contributing now" : ""}`),
      el("dt", {}, "Latest hash"), el("dd", { class: "mono" }, short(s.latest.contributionHash)),
      el("dt", {}, "Beacon"), el("dd", {}, `Bitcoin ${s.beacon.network} block `, el("span", { class: "mono" }, String(s.beacon.height)),
        `. The queue closes at block ${s.beacon.closeBeforeHeight}${s.closed ? ` (closed at ${s.closed.tipHeight ?? "an unrecorded height"})` : ""}.`),
      el("dt", {}, "Circuit"), el("dd", { class: "mono" }, `${s.circuit.constraints} constraints, r1cs ${short(s.circuit.r1csSha256)}`),
      el("dt", {}, "Phase 1"), el("dd", { class: "mono" }, s.ptau.name),
    ),
  );
  if (!busy) $("join-btn").disabled = s.phase !== "open";
  $("join-note").textContent = s.phase === "open" ? "" : ERROR_TEXT[s.phase] ?? "";
}

/* ------------------------------------------------------------------ contributing */

let busy = false;
let pass = null; // the queue credential: memory only
let abort = null;

function stepList(active) {
  const steps = ["Waiting in the queue", "Downloading the latest key", "Adding your contribution", "Uploading", "Coordinator verifies it"];
  return el("ol", { class: "cer-steps" }, steps.map((t, i) => el("li", { class: i < active ? "is-done" : i === active ? "is-now" : "" }, t)));
}

function progress(text, frac = null) {
  return el("div", { class: "cer-progress" },
    el("p", {}, text),
    frac === null ? null : el("div", { class: "cer-bar" }, el("div", { class: "cer-bar-fill", style: `width:${Math.round(frac * 100)}%` })));
}

function runWorker(prev, name, entropy, onLog) {
  return new Promise((done, fail) => {
    const w = new Worker(new URL("./contribute.worker.js", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "log") onLog(m.message);
      else {
        w.terminate();
        if (m.type === "done") done({ zkey: m.zkey, contributionHash: m.contributionHash });
        else fail(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      fail(new Error(e.message || "the contribution worker failed"));
    };
    w.postMessage({ prev, name, entropy });
  });
}

const leaveWarning = (e) => {
  e.preventDefault();
  e.returnValue = "";
};

async function contribute(name, extra) {
  const box = $("run");
  box.hidden = false;
  busy = true;
  $("join-btn").disabled = true;
  window.addEventListener("beforeunload", leaveWarning);
  abort = new AbortController();
  const leaveBtn = el("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: leave }, "Leave the queue");
  try {
    const joined = await client.join(name);
    pass = joined.pass;
    const t = await client.waitForTurn(pass, {
      signal: abort.signal,
      onUpdate: (u) => {
        if (u.state === "waiting") {
          replace(box, stepList(0), progress(u.position === 0 ? "You are next." : `${u.position} ahead of you. Keep this tab open: it tells the coordinator you are still here.`), leaveBtn);
        } else if (u.state === "retrying") {
          replace(box, stepList(0), progress("Lost contact with the coordinator, retrying…"), leaveBtn);
        }
      },
    });
    replace(box, stepList(1), progress(`Downloading key #${t.base.index} (${mb(t.base.bytes)})…`, 0));
    const prev = await client.download(t.base.url, {
      expectSha256: t.base.zkeySha256,
      signal: abort.signal,
      onProgress: (got, total) => replace(box, stepList(1), progress(`Downloading key #${t.base.index}: ${mb(got)} of ${mb(total || t.base.bytes)}`, got / (total || t.base.bytes))),
    });
    const log = el("pre", { class: "cer-log mono" });
    replace(box, stepList(2), progress(`Adding your contribution. This takes a minute or two; the deadline is ${new Date(t.deadline).toLocaleTimeString()}.`), log);
    // 64 fresh random bytes (plus your text) for this contribution only; snarkjs adds 64 more.
    let entropy = freshEntropy(extra);
    let result;
    try {
      result = await runWorker(prev, name, entropy, (m) => {
        log.textContent = `${log.textContent}${m}\n`.split("\n").slice(-6).join("\n");
      });
    } finally {
      entropy = null;
    }
    // What this browser knows on its own: the receipt is checked against these, never the reverse.
    const local = { contributionHash: result.contributionHash, zkeySha256: await sha256Hex(result.zkey), prevZkeySha256: t.base.zkeySha256 };
    replace(box, stepList(3), progress(`Uploading ${mb(result.zkey.length)}…`));
    const up = client.upload(pass, result.zkey);
    setTimeout(() => {
      if (box.querySelector(".cer-steps li.is-now")?.textContent === "Uploading") {
        replace(box, stepList(4), progress("The coordinator is checking your contribution against the circuit and phase 1. This can take a few minutes."));
      }
    }, 3000);
    const receipt = await up;
    showReceipt(receipt, local);
    replace(box);
    box.hidden = true;
  } catch (e) {
    if (e?.code !== "aborted") replace(box, el("p", { class: "cer-error" }, explain(e)));
  } finally {
    pass = null;
    busy = false;
    abort = null;
    window.removeEventListener("beforeunload", leaveWarning);
    refreshStatus();
  }
}

async function leave() {
  const p = pass;
  abort?.abort();
  if (p) await client.leave(p).catch(() => {});
  replace($("run"), el("p", {}, "You left the queue."));
}

/* ------------------------------------------------------------------ receipt and lookup */

function download(name, text) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

function showReceipt(receipt, local) {
  const check = checkReceipt(receipt, local);
  // The saved receipt and the lookup always use the values computed in this browser.
  const mine = ownReceipt(receipt, local);
  const text = check.ok
    ? receiptText(mine, { origin: location.origin })
    : `WARNING: the coordinator's answer did not match this contribution (${check.problems.join("; ")}). Do not trust this run.\n\n${receiptText(mine, { origin: location.origin })}`;
  const result = el("p", { class: "small" });
  replace(
    $("receipt"),
    el("h2", { class: "h2-app" }, check.ok ? "Your contribution is in" : "The coordinator's answer does not match your contribution"),
    check.ok ? null : el("p", { class: "cer-error" }, `Do not trust this run: ${check.problems.join("; ")}. Your own contribution hash is below; check whether it appears in the transcript, and tell other participants.`),
    el("p", {}, "Save this receipt. Your contribution hash is the proof that your randomness is part of the final key: once the ceremony ends, check that it appears in the published transcript."),
    el("pre", { class: "cer-receipt mono" }, text),
    el("div", { class: "cer-row" },
      el("button", { class: "btn btn--secondary btn--sm", type: "button", onclick: () => navigator.clipboard?.writeText(text) }, "Copy receipt"),
      el("button", { class: "btn btn--secondary btn--sm", type: "button", onclick: () => download(`${mine.ceremony}-${String(mine.index).padStart(4, "0")}-receipt.txt`, text) }, "Save receipt"),
      el("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => lookup(mine.contributionHash, result) }, "Check my hash in the transcript"),
    ),
    result,
  );
  $("receipt").hidden = false;
  $("receipt").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function lookup(hash, out) {
  const h = normalizeHash(hash);
  if (!h) return replace(out, "That is not a contribution hash (128 hex characters).");
  try {
    const t = await client.transcript();
    const c = findContribution(t, h);
    replace(out, c
      ? `Found: contribution #${c.index} by "${c.name}", accepted ${c.acceptedAt}.${t.final ? " The ceremony is finalized." : ""}`
      : `Not in the transcript (${t.contributions.length} contributions).`);
  } catch (e) {
    replace(out, `Could not read the transcript: ${explain(e)}`);
  }
}

/* ------------------------------------------------------------------ wiring */

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) return;
  const name = $("name").value.trim();
  if (!/^[\x20-\x7e]{1,64}$/.test(name)) {
    $("join-note").textContent = ERROR_TEXT.bad_name;
    return;
  }
  $("join-note").textContent = "";
  contribute(name, $("extra").value);
  $("extra").value = "";
});
$("lookup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  lookup($("lookup-hash").value, $("lookup-out"));
});
$("transcript-link").href = "/ceremony/api/transcript.json";

refreshStatus();
setInterval(() => {
  if (document.visibilityState === "visible") refreshStatus();
}, 15000);

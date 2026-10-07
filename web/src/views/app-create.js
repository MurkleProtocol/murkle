// /app/create: a 4-step stepper (visual.md §9). 1 password, 2 the 24 words
// (blurred until press-and-hold), 3 confirm three random words, 4 done. The vault
// is written only at step 4, after the words are confirmed. The phrase lives in
// this closure and nowhere else until it is sealed.
import { html } from "../ui/dom.js";
import { icon, glyphSVG } from "../ui/icons.js";
import { button, field, panel } from "../ui/components.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import { navigate } from "../router.js";
import { BRAND } from "../config.js";
import { newPhrase, createWallet, hasVault, hasLegacy, currentSession, normalizePhrase } from "../session.js";
import { ensureStyles, pageHead, passwordFields, wirePasswordFields, KDF_COPY, callout, formError } from "./app-shared.js";

let clipboardTimer = null;
const STEP_NAMES = ["Password", "Recovery words", "Confirm", "Done"];

function stepsTop(i) {
  return html`<div class="stack stack--s"><div class="eyebrow">STEP ${i + 1} OF 4 · ${STEP_NAMES[i].toUpperCase()}</div><div class="steps-top" aria-hidden="true">${STEP_NAMES.map((_, k) => html`<span class="${k <= i ? "is-on" : ""}"></span>`)}</div></div>`;
}

export function existingWallet(root, what) {
  root.innerHTML = html`<div class="wl wl-center">
    ${panel({
      certified: true,
      cls: "lockpanel",
      body: html`${glyphSVG({ size: 40 })}<h1 class="h2-app">This browser already has a wallet</h1>
        <p class="t-2">To ${what}, first remove the current one in Settings. Save its 24 words before you do: they are the only way back to its notes.</p>
        <div class="inline-actions">${button({ label: currentSession() ? "Open Settings" : "Unlock it", href: currentSession() ? "/app/settings#danger" : "/app", kind: "neutral" })}${button({ label: "Back to the wallet", href: "/app", kind: "ghost" })}</div>`,
    })}
  </div>`;
}

// A pre-rename plaintext wallet is migrated first: once a vault exists, its migration can't run.
export function legacyWallet(root) {
  root.innerHTML = html`<div class="wl wl-center">
    ${panel({
      certified: true,
      cls: "lockpanel",
      body: html`${glyphSVG({ size: 40 })}<h1 class="h2-app">Protect your current wallet first</h1>
        <p class="t-2">This browser holds a wallet from before ${BRAND} got its name, and its recovery phrase is stored unencrypted. Set a password for it first. To use a different wallet afterwards, save its 24 words and remove it in Settings.</p>
        <div class="inline-actions">${button({ label: "Protect it now", href: "/app", kind: "neutral" })}</div>`,
    })}
  </div>`;
}

export function render(root) {
  ensureStyles();
  if (hasVault()) return existingWallet(root, "create a new one");
  if (hasLegacy()) return legacyWallet(root);
  let password = null;
  let phrase = null;
  let picks = null;
  let offGlobal = () => {};

  const shell = (i, body) => html`<div class="wl"><div class="wl-form">${pageHead({ eyebrow: "NEW WALLET", title: "Create a wallet", streamer: false })}${stepsTop(i)}${body}</div></div>`;

  function stepPassword() {
    root.innerHTML = shell(
      0,
      html`<form class="stack stack--l" novalidate data-f>
        <p class="t-2">${KDF_COPY}</p>
        ${passwordFields()}
        ${callout("If you forget the password, your 24 words still restore everything. Nobody, including us, can reset it.", "info")}
        <span data-error-anchor></span>
        <div class="sticky-cta">${button({ label: "Continue", type: "submit", kind: "neutral", size: "lg", iconRight: "arrow-right" })}</div>
      </form>`,
    );
    const form = root.querySelector("[data-f]");
    const validate = wirePasswordFields(form);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      try {
        password = validate();
      } catch (err) {
        return formError(form, err.message);
      }
      phrase ??= newPhrase();
      stepWords();
    });
  }

  function stepWords() {
    const words = phrase.split(" ");
    root.innerHTML = shell(
      1,
      html`<div class="stack stack--l">
        ${callout(html`<b>Anyone with these words owns your notes.</b> Write them down on paper, in order. Don't screenshot them, don't paste them into chats or cloud notes.`, "warn")}
        <div class="phrase-wrap is-hidden" data-phrase>
          <ol class="phrase-grid" aria-label="Recovery words">${words.map((w, i) => html`<li class="pw"><i>${i + 1}</i><b>${w}</b></li>`)}</ol>
          <div class="phrase-hold">${button({ label: "Press and hold to show", kind: "neutral", icon: "eye", action: "hold" })}</div>
        </div>
        <div class="inline-actions">
          ${button({ label: "Copy words", kind: "ghost", size: "sm", icon: "copy", action: "copy" })}
          ${button({ label: "Use different words", kind: "ghost", size: "sm", icon: "refresh", action: "regen" })}
        </div>
        <p class="caption t-3">Copying puts the words on your clipboard, where other apps can read them. We try to clear it after 30 seconds (best effort; not every browser allows it).</p>
        <label class="cluster small"><input type="checkbox" data-saved> I wrote the 24 words down, in order.</label>
        <div class="sticky-cta inline-actions">${button({ label: "Back", kind: "ghost", action: "back" })}${button({ label: "Continue", kind: "neutral", size: "lg", action: "next", iconRight: "arrow-right", disabled: true, reason: "Confirm that you wrote the words down." })}</div>
      </div>`,
    );
    const wrap = root.querySelector("[data-phrase]");
    const hold = root.querySelector("[data-action=hold]");
    const show = (e) => {
      e.preventDefault();
      wrap.classList.remove("is-hidden");
    };
    const hide = () => wrap.classList.add("is-hidden");
    hold.addEventListener("pointerdown", show);
    hold.addEventListener("keydown", (e) => (e.key === " " || e.key === "Enter") && show(e));
    hold.addEventListener("keyup", hide);
    // Words hide again as soon as the press ends anywhere on the page.
    offGlobal();
    for (const t of ["pointerup", "pointercancel", "blur"]) addEventListener(t, hide);
    offGlobal = () => {
      for (const t of ["pointerup", "pointercancel", "blur"]) removeEventListener(t, hide);
    };
    const saved = root.querySelector("[data-saved]");
    const nextWrap = root.querySelector("[data-action=next]").closest(".btn-wrap");
    saved.addEventListener("change", () => {
      const btn = root.querySelector("[data-action=next]");
      btn.disabled = !saved.checked;
      nextWrap.querySelector(".reason")?.toggleAttribute("hidden", saved.checked);
    });
    root.querySelector("[data-action=copy]").addEventListener("click", async () => {
      if (!(await copyText(phrase))) return toast({ kind: "warn", title: "Couldn't copy.", body: "Write the words down by hand instead." });
      toast({ kind: "warn", title: "Words copied.", body: "Paste them somewhere offline. The clipboard is cleared in 30 s if this tab still has focus." });
      // Module-level timer: it keeps running if the user leaves this page.
      clearTimeout(clipboardTimer);
      clipboardTimer = setTimeout(() => {
        if (document.hasFocus()) navigator.clipboard?.writeText("").catch(() => {});
      }, 30_000);
    });
    root.querySelector("[data-action=regen]").addEventListener("click", () => {
      phrase = newPhrase();
      stepWords();
    });
    root.querySelector("[data-action=back]").addEventListener("click", stepPassword);
    root.querySelector("[data-action=next]").addEventListener("click", () => {
      if (!saved.checked) return;
      stepConfirm();
    });
  }

  function stepConfirm() {
    const idx = new Set();
    while (idx.size < 3) idx.add(crypto.getRandomValues(new Uint32Array(1))[0] % 24);
    picks = [...idx].sort((a, b) => a - b);
    root.innerHTML = shell(
      2,
      html`<form class="stack stack--l" novalidate data-f>
        <p class="t-2">Type these three words from your list, so we know the copy you wrote down is complete.</p>
        <div class="confirm-words">${picks.map((i) => field({ label: `Word ${i + 1}`, name: `w${i}`, mono: true, attrs: { autocomplete: "off", autocapitalize: "off", spellcheck: "false" } }))}</div>
        <span data-error-anchor></span>
        <div class="sticky-cta inline-actions">${button({ label: "Show the words again", kind: "ghost", action: "back" })}${button({ label: "Encrypt and finish", type: "submit", kind: "neutral", size: "lg", icon: "lock" })}</div>
      </form>`,
    );
    const form = root.querySelector("[data-f]");
    root.querySelector("[data-action=back]").addEventListener("click", stepWords);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const words = phrase.split(" ");
      const wrong = picks.filter((i) => normalizePhrase(form.querySelector(`[name=w${i}]`).value) !== words[i]);
      if (wrong.length) return formError(form, `Word ${wrong.map((i) => i + 1).join(" and ")} doesn't match. Check your copy.`);
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.innerHTML = html`<span class="spinner spinner--14"></span><span>Encrypting…</span>`;
      try {
        await createWallet(phrase, password);
        password = null;
        phrase = null;
        stepDone();
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = html`${icon("lock", { size: 16 })}<span>Encrypt and finish</span>`;
        formError(form, err.message);
      }
    });
  }

  function stepDone() {
    root.innerHTML = shell(
      3,
      html`${panel({
        certified: true,
        cls: "lockpanel",
        body: html`<span class="ok-mark">${icon("check", { size: 20 })}<span class="eyebrow" style="color:inherit">Encrypted on this device</span></span>
          <h2 class="h2-app">Wallet encrypted on this device</h2>
          <p class="t-2">Your ${BRAND} wallet is ready. It locks itself after 15 minutes idle (change it in Settings). Your first private note arrives when you mint from an open token or someone pays you.</p>
          <div class="inline-actions">${button({ label: "Open portfolio", href: "/app", kind: "neutral" })}${button({ label: "Browse mints", href: "/app/mint", kind: "secondary" })}${button({ label: "Receive", href: "/app/receive", kind: "ghost" })}</div>`,
      })}`,
    );
  }

  stepPassword();
  return () => {
    offGlobal();
    password = null;
    phrase = null;
  };
}

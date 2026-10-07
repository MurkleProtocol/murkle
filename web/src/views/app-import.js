// /app/import: restore from 24 words with live BIP-39 validation, plus a new
// password. The words never leave this page except sealed into the vault.
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { button, field } from "../ui/components.js";
import { toast } from "../ui/toast.js";
import { navigate } from "../router.js";
import { phraseCheck, createWallet, hasVault, hasLegacy } from "../session.js";
import { ensureStyles, pageHead, passwordFields, wirePasswordFields, KDF_COPY, callout, formError } from "./app-shared.js";
import { existingWallet, legacyWallet } from "./app-create.js";

export function render(root) {
  ensureStyles();
  if (hasVault()) return existingWallet(root, "restore a different wallet");
  if (hasLegacy()) return legacyWallet(root);
  root.innerHTML = html`<div class="wl"><form class="wl-form" novalidate data-f>
    ${pageHead({ eyebrow: "RESTORE", title: "Restore from 24 words", lead: "Your notes are found again by scanning the whole public pool in this browser. Nothing about them is sent to any server.", streamer: false })}
    <div class="stack stack--s">
      ${field({ label: "Recovery phrase", name: "phrase", textarea: true, rows: 4, mono: true, help: "Paste or type your 24 words, separated by spaces.", attrs: { autocomplete: "off", autocapitalize: "off", spellcheck: "false", autofocus: true } })}
    </div>
    <div class="stack stack--s"><div class="eyebrow">NEW PASSWORD FOR THIS BROWSER</div><p class="caption t-3">${KDF_COPY}</p></div>
    ${passwordFields({ autofocus: false })}
    ${callout("Only restore on a device you trust. Anyone who sees these words can take every note they control.", "warn")}
    <span data-error-anchor></span>
    <div class="sticky-cta">${button({ label: "Restore wallet", type: "submit", kind: "neutral", size: "lg", icon: "unlock" })}</div>
  </form></div>`;
  const form = root.querySelector("[data-f]");
  const ta = form.querySelector("[name=phrase]");
  const status = ta.closest(".field").querySelector(".field-msg");
  status.setAttribute("aria-live", "polite");
  const validate = wirePasswordFields(form);
  const paint = () => {
    const c = phraseCheck(ta.value);
    status.className = `field-msg caption ${c.valid ? "ok-mark" : c.unknown.length || (c.count === 24 && !c.valid) ? "t-danger" : "t-3"}`;
    status.innerHTML = c.valid ? html`${icon("check", { size: 14 })}${c.message}` : html`${c.message}`;
    return c;
  };
  ta.addEventListener("input", paint);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError(form, null);
    const c = paint();
    if (!c.valid) return formError(form, `The recovery phrase isn't valid yet. ${c.message}`);
    let pw;
    try {
      pw = validate();
    } catch (err) {
      return formError(form, err.message);
    }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.innerHTML = html`<span class="spinner spinner--14"></span><span>Encrypting…</span>`;
    try {
      await createWallet(ta.value, pw);
      ta.value = "";
      toast({ kind: "success", title: "Wallet restored and encrypted on this device.", body: "Scanning the pool for your notes now." });
      navigate("/app");
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = html`${icon("unlock", { size: 16 })}<span>Restore wallet</span>`;
      formError(form, err.message);
    }
  });
  return () => {
    ta.value = "";
  };
}

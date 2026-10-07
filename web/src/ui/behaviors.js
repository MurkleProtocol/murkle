/**
 * Global delegated behaviors, installed once by the shell. Components stay declarative HTML
 * (they work after any innerHTML render); these listeners give them life.
 *
 *   [data-copy="text"]            click copies the text, the icon flips to a check, toast "Copied"
 *   [data-tip="sentence"]         tooltip/popover on hover, keyboard focus or tap
 *   [data-hexmap] [data-k]        hover/tap a field: others dim to 35%, the legend line shows
 *   [data-seg]                    segmented control (radio semantics, arrow keys, <select>
 *                                 fallback). Dispatches "seg-change" { value, name } (bubbles).
 *   [data-seg][data-name=theme]   applies the theme (ui/theme.js) and keeps every theme control in sync
 *   html.doc-hidden               set while the tab is hidden (pauses the one looping animation)
 *
 * API
 *   installBehaviors(root = document)   idempotent
 *   copyText(text) -> Promise<boolean>
 */
import { toast } from "./toast.js";
import { icon } from "./icons.js";
import { setThemePref, onThemeChange, getThemePref } from "./theme.js";

let installed = false;

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
    return ok;
  }
}

/* ---------- tooltip ---------- */
let tip = null;
let tipFor = null;

function showTip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip";
    tip.id = "ui-tip";
    tip.setAttribute("role", "tooltip");
    document.body.append(tip);
  }
  tip.textContent = text;
  tipFor = target;
  target.setAttribute("aria-describedby", "ui-tip");
  tip.classList.add("is-on");
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
  const above = r.top - h - 8 > 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${above ? r.top - h - 8 : r.bottom + 8}px`;
}

function hideTip() {
  if (!tip) return;
  tip.classList.remove("is-on");
  tipFor?.removeAttribute("aria-describedby");
  tipFor = null;
}

/* ---------- segmented ---------- */
function selectSeg(wrap, value, focus = false) {
  const opts = [...wrap.querySelectorAll(".seg-opt")];
  if (!opts.some((o) => o.dataset.value === value)) return;
  for (const o of opts) {
    const on = o.dataset.value === value;
    o.setAttribute("aria-checked", on ? "true" : "false");
    o.tabIndex = on ? 0 : -1;
    if (on && focus) o.focus();
  }
  const sel = wrap.querySelector(".seg-select");
  if (sel) sel.value = value;
  const changed = wrap.dataset.value !== value;
  wrap.dataset.value = value;
  if (changed) wrap.dispatchEvent(new CustomEvent("seg-change", { bubbles: true, detail: { value, name: wrap.dataset.name } }));
}

function syncThemeControls(pref) {
  for (const w of document.querySelectorAll('[data-seg][data-name="theme"]')) {
    if (w.dataset.value !== pref) {
      for (const o of w.querySelectorAll(".seg-opt")) {
        const on = o.dataset.value === pref;
        o.setAttribute("aria-checked", on ? "true" : "false");
        o.tabIndex = on ? 0 : -1;
      }
      const sel = w.querySelector(".seg-select");
      if (sel) sel.value = pref;
      w.dataset.value = pref;
    }
  }
}

/* ---------- hexmap ---------- */
function hexFocus(map, keys) {
  const set = new Set(keys ? keys.split(" ") : []);
  map.classList.toggle("is-dim", set.size > 0);
  for (const c of map.querySelectorAll(".hx-c")) c.classList.toggle("is-on", set.has(c.dataset.k));
  for (const c of map.querySelectorAll(".hx-chip")) c.classList.toggle("is-on", c.dataset.k.split(" ").some((k) => set.has(k)));
  const first = keys ? keys.split(" ")[0] : "";
  for (const l of map.querySelectorAll("[data-line]")) l.hidden = l.dataset.line !== first;
}

export function installBehaviors(root = document) {
  if (installed) return;
  installed = true;

  root.addEventListener("click", async (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) {
      e.preventDefault();
      const ok = await copyText(c.dataset.copy);
      if (ok) {
        const prev = c.innerHTML;
        if (c.classList.contains("icon-btn")) {
          c.innerHTML = icon("check", { size: 14 });
          setTimeout(() => (c.innerHTML = prev), 1200);
        }
        toast({ kind: "success", title: "Copied", body: null, timeout: 2500 });
      } else {
        toast({ kind: "warn", title: "Couldn't copy.", body: "Your browser blocked the clipboard. Select the text and copy it by hand." });
      }
      return;
    }
    const opt = e.target.closest("[data-seg] .seg-opt");
    if (opt) selectSeg(opt.closest("[data-seg]"), opt.dataset.value);
    const hx = e.target.closest("[data-hexmap] [data-k]");
    if (hx) {
      const map = hx.closest("[data-hexmap]");
      const keys = hx.dataset.k;
      const same = map.dataset.focus === keys;
      map.dataset.focus = same ? "" : keys;
      hexFocus(map, same ? "" : keys);
    }
  });

  root.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-seg] .seg-select");
    if (sel) selectSeg(sel.closest("[data-seg]"), sel.value);
  });

  root.addEventListener("keydown", (e) => {
    const opt = e.target.closest?.("[data-seg] .seg-opt");
    if (!opt) return;
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const wrap = opt.closest("[data-seg]");
    const opts = [...wrap.querySelectorAll(".seg-opt")];
    const i = (opts.indexOf(opt) + keys[e.key] + opts.length) % opts.length;
    selectSeg(wrap, opts[i].dataset.value, true);
  });

  root.addEventListener("seg-change", (e) => {
    if (e.detail?.name === "theme") setThemePref(e.detail.value);
  });
  onThemeChange((pref) => syncThemeControls(pref));
  syncThemeControls(getThemePref());

  // Tooltips: mouse hover, keyboard focus, touch tap.
  root.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const t = e.target.closest?.("[data-tip]");
    if (t && t !== tipFor) showTip(t);
  });
  root.addEventListener("pointerout", (e) => {
    if (e.pointerType !== "mouse" || !tipFor) return;
    if (!tipFor.contains(e.relatedTarget)) hideTip();
  });
  root.addEventListener("focusin", (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (t && t.matches(":focus-visible")) showTip(t);
  });
  root.addEventListener("focusout", () => hideTip());
  root.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse") return;
    const t = e.target.closest?.("[data-tip]");
    if (!t) return hideTip();
    if (t.matches("a, button, input, select, textarea") && !t.classList.contains("copy")) return;
    if (tipFor === t) hideTip();
    else showTip(t);
  });
  addEventListener("scroll", hideTip, { passive: true });

  // Hexmap hover preview (mouse only; taps toggle through the click handler).
  root.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const k = e.target.closest?.("[data-hexmap] [data-k]");
    if (!k) return;
    const map = k.closest("[data-hexmap]");
    if (!map.dataset.focus) hexFocus(map, k.dataset.k);
  });
  root.addEventListener("pointerout", (e) => {
    if (e.pointerType !== "mouse") return;
    const map = e.target.closest?.("[data-hexmap]");
    if (map && !map.contains(e.relatedTarget) && !map.dataset.focus) hexFocus(map, "");
  });

  const vis = () => document.documentElement.classList.toggle("doc-hidden", document.hidden);
  document.addEventListener("visibilitychange", vis);
  vis();
}

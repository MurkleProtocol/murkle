/**
 * Modals, bottom sheets and popovers (visual.md section 7).
 * Desktop: a centered modal, max 520px, radius 14, --shadow-pop over --scrim.
 * Phone (under 768px): a bottom sheet with a grabber, max-height 90dvh, inner scroll and
 * safe-area padding. Esc and scrim clicks close every sheet except locked ones (signing,
 * proving, broadcast). Focus is trapped inside and restored on close.
 *
 * API
 *   openSheet({ title, eyebrow, body, actions, locked = false, onClose, label, cls })
 *       -> { el, body: Element, close(), setBody(markup), setLocked(bool) }
 *       body / actions: Safe markup or a Node. Elements with [data-sheet-close] close it.
 *   openPopover(anchor, body, { onClose, cls, width = 320 })
 *       -> { el, close() }  positioned under `anchor`; closes on outside click, Esc or scroll.
 *       Focus moves in on open ([data-autofocus], the checked menu item or the first control)
 *       and back to `anchor` on close. Tab past either end closes it, so the tab order reads
 *       as if the popover sat right after its anchor. [role=menu] also takes arrows, Home, End.
 *       Under 768px it opens as a bottom sheet instead (same content).
 *   popoverKey(key, { index, count, shift, menu }) -> { focus, prevent } | { close, prevent } | null
 *       the popover's keyboard model (pure); index is the focused item, -1 when outside
 *   closeAllPopovers()
 *   closeAllSheets()                 closes every open sheet, locked ones too (wallet lock)
 */
import { html, toNode, reducedMotion } from "./dom.js";
import { icon } from "./icons.js";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const isPhone = () => typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;

function fill(target, content) {
  target.replaceChildren();
  if (content === null || content === undefined) return;
  if (content instanceof Node) target.append(content);
  else target.append(toNode(`<div class="sheet-content">${content}</div>`));
}

const open = new Set();

export function openSheet({ title = "", eyebrow = null, body = "", actions = null, locked = false, onClose = null, label = null, cls = "" } = {}) {
  const prevFocus = document.activeElement;
  const root = toNode(
    html`<div class="sheet-layer ${cls}" role="presentation">
      <div class="sheet-scrim" data-scrim></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${label ?? title ?? "Dialog"}">
        <div class="sheet-grabber" aria-hidden="true"></div>
        <header class="sheet-head">
          <div>${eyebrow ? html`<div class="eyebrow">${eyebrow}</div>` : ""}${title ? html`<h2 class="h3 sheet-title">${title}</h2>` : ""}</div>
          <button type="button" class="icon-btn sheet-x" data-sheet-close aria-label="Close">${icon("cross")}</button>
        </header>
        <div class="sheet-body"></div>
        <footer class="sheet-foot" hidden></footer>
      </div>
    </div>`,
  );
  const sheet = root.querySelector(".sheet");
  const bodyEl = root.querySelector(".sheet-body");
  const foot = root.querySelector(".sheet-foot");
  fill(bodyEl, body);
  if (actions) {
    fill(foot, actions);
    foot.hidden = false;
  }
  let isLocked = locked;
  const xBtn = root.querySelector(".sheet-x");
  xBtn.hidden = isLocked;

  const onKey = (e) => {
    if (e.key === "Escape" && !isLocked) {
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      const items = [...sheet.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const onClick = (e) => {
    if (isLocked) return;
    if (e.target.closest("[data-sheet-close]") || e.target.matches("[data-scrim]")) close();
  };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    open.delete(api);
    root.removeEventListener("keydown", onKey);
    root.classList.remove("is-open");
    const done = () => {
      root.remove();
      if (!open.size) document.documentElement.classList.remove("has-sheet");
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      onClose?.();
    };
    if (reducedMotion()) done();
    else setTimeout(done, 240);
  }
  root.addEventListener("keydown", onKey);
  root.addEventListener("click", onClick);
  document.body.append(root);
  document.documentElement.classList.add("has-sheet");
  requestAnimationFrame(() => {
    root.classList.add("is-open");
    const target = sheet.querySelector("[autofocus], [data-autofocus]") ?? sheet.querySelector(".sheet-body " + FOCUSABLE) ?? sheet;
    sheet.tabIndex = -1;
    target.focus({ preventScroll: true });
  });
  const api = {
    el: root,
    body: bodyEl,
    close,
    setBody: (content) => fill(bodyEl, content),
    setLocked(v) {
      isLocked = !!v;
      xBtn.hidden = isLocked;
    },
  };
  open.add(api);
  return api;
}

export function closeAllSheets() {
  for (const s of [...open]) s.close();
}

const pops = new Set();

export function closeAllPopovers() {
  for (const p of [...pops]) p.close();
}

export function popoverKey(key, { index = -1, count = 0, shift = false, menu = false } = {}) {
  if (key === "Escape") return { close: true, prevent: false };
  if (key === "Tab") {
    if (index < 0) return count && !shift ? { focus: 0, prevent: true } : null;
    // Past an end: back to the anchor. Forward, the browser's own Tab then moves on from there.
    if (shift ? index === 0 : index === count - 1) return { close: true, prevent: shift };
    return null;
  }
  if (!menu || !count) return null;
  const to = { ArrowDown: (index + 1) % count, ArrowUp: index < 0 ? count - 1 : (index - 1 + count) % count, Home: 0, End: count - 1 }[key];
  return to === undefined ? null : { focus: to, prevent: true };
}

export function openPopover(anchor, body, { onClose = null, cls = "", width = 320, title = "" } = {}) {
  closeAllPopovers();
  if (isPhone()) {
    const s = openSheet({ title, body, onClose, cls: `sheet--popover ${cls}` });
    return { el: s.el, close: s.close };
  }
  const el = toNode(html`<div class="popover ${cls}" role="dialog" aria-label="${title || "Details"}" style="width:${width}px"></div>`);
  fill(el, body);
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    // Anchors on the right half open leftwards (right edges aligned), others rightwards.
    const ideal = r.left > window.innerWidth / 2 ? r.right - w : r.left;
    const left = Math.min(window.innerWidth - w - 12, Math.max(12, ideal));
    el.style.left = `${left}px`;
    el.style.top = `${r.bottom + 8}px`;
  };
  place();
  anchor.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => el.classList.add("is-open"));
  const shown = (n) => n.getClientRects().length > 0;
  const controls = () => [...el.querySelectorAll(FOCUSABLE)].filter(shown);
  const menuItems = () => [...el.querySelectorAll('[role^="menuitem"]')].filter(shown);
  const onDoc = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) close(false);
  };
  const onKey = (e) => {
    const arrows = e.key !== "Tab" && e.key !== "Escape";
    const list = arrows ? menuItems() : controls();
    const act = popoverKey(e.key, { index: list.indexOf(document.activeElement), count: list.length, shift: e.shiftKey, menu: arrows && !!el.querySelector('[role="menu"]') });
    if (!act) return;
    if (act.prevent) e.preventDefault();
    if (act.close) close(true);
    else list[act.focus].focus({ preventScroll: true });
  };
  el.addEventListener("focusout", (e) => {
    const to = e.relatedTarget;
    if (to && !el.contains(to) && !anchor.contains(to)) close(false);
  });
  const onScroll = () => close();
  setTimeout(() => {
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    addEventListener("scroll", onScroll, { passive: true, once: true });
    addEventListener("resize", onScroll, { once: true });
  });
  el.addEventListener("click", (e) => {
    if (e.target.closest("a[href], [data-sheet-close]")) close();
  });
  let closed = false;
  // refocus: put focus back on the anchor (by default only when it was inside the popover).
  function close(refocus = el.contains(document.activeElement)) {
    if (closed) return;
    closed = true;
    pops.delete(api);
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDoc);
    document.removeEventListener("keydown", onKey);
    removeEventListener("scroll", onScroll);
    removeEventListener("resize", onScroll);
    el.remove();
    if (refocus === true) anchor.focus({ preventScroll: true });
    onClose?.();
  }
  const api = { el, close };
  pops.add(api);
  // Keyboard users land inside; preventScroll, since a scroll closes the popover.
  (el.querySelector("[data-autofocus]") ?? el.querySelector('[role^="menuitem"][aria-checked="true"]') ?? controls()[0])?.focus({ preventScroll: true });
  return api;
}

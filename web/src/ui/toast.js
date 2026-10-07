/**
 * Toasts (visual.md section 7). Desktop: top-right, 380px. Phone: bottom-center above the tab
 * bar. At most 3 at once (the oldest goes first). Info and success dismiss after 7 s, warn after
 * 10 s; danger stays until closed. Copy follows "What happened. What to do."
 *
 * API
 *   mountToasts(container?) -> host element   (the shell calls it once; toast() mounts lazily)
 *   toast({ kind = "info" | "success" | "warn" | "danger", title, body, action, timeout })
 *       -> id. action: { label, href } (in-app link) or { label, onClick }.
 *   dismiss(id)
 *   toastError(error, { title })   danger toast from an Error/ApiError (uses its message)
 */
import { html, toNode, reducedMotion } from "./dom.js";
import { icon } from "./icons.js";

let host = null;
let seq = 0;
const live = new Map();
const ICON = { info: "info", success: "check", warn: "warn", danger: "warn" };
const TIMEOUT = { info: 7000, success: 7000, warn: 10000, danger: 0 };

export function mountToasts(container = document.body) {
  if (host && host.isConnected) return host;
  host = toNode(`<div class="toast-host" role="region" aria-label="Notifications"></div>`);
  container.append(host);
  return host;
}

export function toast({ kind = "info", title, body = null, action = null, timeout = null } = {}) {
  mountToasts();
  const id = `t${++seq}`;
  const el = toNode(
    html`<div class="toast toast--${kind}" role="${kind === "danger" ? "alert" : "status"}" data-toast="${id}">
      <span class="toast-icon">${icon(ICON[kind] ?? "info", { size: 16 })}</span>
      <div class="toast-text">
        <div class="toast-title">${title}</div>
        ${body ? html`<div class="toast-body">${body}</div>` : ""}
        ${action ? html`<div class="toast-act">${action.href ? html`<a href="${action.href}" data-link>${action.label}</a>` : html`<button type="button" class="linklike" data-toast-act>${action.label}</button>`}</div>` : ""}
      </div>
      <button type="button" class="icon-btn icon-btn--xs toast-x" aria-label="Dismiss">${icon("cross", { size: 14 })}</button>
    </div>`,
  );
  el.querySelector(".toast-x").addEventListener("click", () => dismiss(id));
  el.querySelector("[data-toast-act]")?.addEventListener("click", () => {
    action.onClick?.();
    dismiss(id);
  });
  el.querySelector(".toast-act a")?.addEventListener("click", () => dismiss(id));
  host.append(el);
  requestAnimationFrame(() => el.classList.add("is-in"));
  const ms = timeout ?? TIMEOUT[kind] ?? 7000;
  const timer = ms ? setTimeout(() => dismiss(id), ms) : null;
  live.set(id, { el, timer });
  while (live.size > 3) dismiss(live.keys().next().value);
  return id;
}

export function dismiss(id) {
  const t = live.get(id);
  if (!t) return;
  live.delete(id);
  clearTimeout(t.timer);
  t.el.classList.remove("is-in");
  if (reducedMotion()) t.el.remove();
  else setTimeout(() => t.el.remove(), 180);
}

export function toastError(error, { title = "Something went wrong." } = {}) {
  return toast({ kind: "danger", title, body: error?.message ?? String(error) });
}

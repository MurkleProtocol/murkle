/**
 * Theme preference: System / Dark / Light (visual.md section 3). The choice lives in
 * localStorage "ui.theme"; public/theme-boot.js applies it before first paint so there is no
 * flash. With no attribute the system theme applies; dark is the default.
 *
 * API
 *   THEME_KEY                       "ui.theme"
 *   getThemePref() -> "system" | "dark" | "light"
 *   setThemePref(pref)              applies data-theme on <html>, stores it, notifies listeners
 *   effectiveTheme() -> "dark" | "light"
 *   onThemeChange(fn) -> unsubscribe  fn(pref, effective); also fires on system changes
 *   themeControl({ size }) -> Safe   segmented control (data-theme-control), wired by behaviors.js
 */
import { segmented } from "./components.js";

export const THEME_KEY = "ui.theme";
const subs = new Set();

export function getThemePref() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function effectiveTheme() {
  const p = document.documentElement.dataset.theme;
  if (p === "light" || p === "dark") return p;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function notify() {
  const pref = getThemePref();
  const eff = effectiveTheme();
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = eff === "light" ? "#F6F5F1" : "#0A0B0D";
  for (const fn of [...subs]) fn(pref, eff);
}

export function setThemePref(pref) {
  const p = pref === "light" || pref === "dark" ? pref : "system";
  try {
    if (p === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, p);
  } catch {
    // storage blocked: the choice still applies for this page view
  }
  if (p === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = p;
  notify();
}

export function onThemeChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

if (typeof matchMedia === "function") {
  matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", notify);
}

export function themeControl({ size = "sm" } = {}) {
  const value = typeof localStorage === "undefined" ? "system" : getThemePref();
  return segmented(
    [
      { value: "system", label: "System", icon: "monitor" },
      { value: "dark", label: "Dark", icon: "moon" },
      { value: "light", label: "Light", icon: "sun" },
    ],
    { value, name: "theme", label: "Theme", size },
  );
}

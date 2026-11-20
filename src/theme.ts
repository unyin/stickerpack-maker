// Theme preference (SPM-14): follow the OS dark/light setting by default,
// with a per-machine override stored in the webview's localStorage. Keeping
// the preference out of the Rust config leaves theming frontend-only.
// theme.ts sets data-theme on <html>; styles.css carries the token sets.
// The native window chrome (the Windows title bar) is not part of the page,
// so the window's own theme is set to match: null lets it follow the OS.

import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "stickerpack.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

function load(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

let preference: ThemePreference = load();

function apply(): void {
  const resolved =
    preference === "system" ? (media.matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = resolved;
  // Outside Tauri (tests, a plain browser) there is no window to theme.
  getCurrentWindow()
    .setTheme(preference === "system" ? null : preference)
    .catch(() => {});
}

/** Resolve and apply the theme once at boot; track OS changes while on system. */
export function initTheme(): void {
  apply();
  media.addEventListener("change", () => {
    if (preference === "system") apply();
  });
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  if (next === "system") localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, next);
  apply();
}

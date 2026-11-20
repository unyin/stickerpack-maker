// Theme preference (SPM-14): follow the OS dark/light setting by default,
// with a per-machine override stored in the webview's localStorage. Keeping
// the preference out of the Rust config leaves theming frontend-only.
// theme.ts sets data-theme on <html>; styles.css carries the token sets.
// The native window chrome (the Windows title bar) is not part of the page,
// so the window's own theme is set to match: null lets it follow the OS.

import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "stickerpack.theme";
const darkSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** The choices, in display order; the settings view builds its options from this. */
export const THEME_CHOICES: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Follow system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Anything that is not a known choice means "system". */
export function parseThemePreference(value: string): ThemePreference {
  return THEME_CHOICES.find((c) => c.value === value)?.value ?? "system";
}

function load(): ThemePreference {
  return parseThemePreference(localStorage.getItem(STORAGE_KEY) ?? "");
}

let preference: ThemePreference = load();

function apply(): void {
  const resolved =
    preference === "system" ? (darkSchemeQuery.matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = resolved;
  // Outside Tauri (tests, a plain browser) there is no window to theme:
  // getCurrentWindow() throws synchronously there, setTheme() may reject.
  try {
    getCurrentWindow()
      .setTheme(preference === "system" ? null : preference)
      .catch(() => {});
  } catch {
    // no native window
  }
}

/** Resolve and apply the theme once at boot; track OS changes while on system. */
export function initTheme(): void {
  apply();
  darkSchemeQuery.addEventListener("change", () => {
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

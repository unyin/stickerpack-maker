// Emoji style (SPM-17): which emoji font the app draws with — Android (the
// bundled Noto Color Emoji, the DEFAULT), Twemoji (bundled), Windows (system
// Segoe UI Emoji), or the user's own font file, loaded at runtime.
//
// The setting rides the seam the app already renders emoji through:
// --font-emoji (styles.css). Every emoji-showing element already puts that
// var in font-family, so applying a style is one runtime var flip on <html>;
// styles.css keeps the Noto-first (Android) value as the first-paint default
// for pages where this module has not run. Persisted in the RUST app config
// next to the Library path (owner, task decision 2026-11-21) — unlike the
// theme, a frontend-only localStorage preference (theme.ts).
//
// Editor text layers rasterise in Rust with per-character font fallback and
// the style's emoji chain (ADR-0005; SPM-20 reads the style field from the
// config for that seam), so this style picks the emoji font text layers
// commit with too — and the typing overlay previews it through the same
// var(--font-emoji).

import { readCustomEmojiFont, setEmojiStyle, type EmojiStyle } from "./api";
import { errorMessage } from "./ui";

/** The choices in display order; the settings view builds its options from this. */
export const EMOJI_STYLE_CHOICES: readonly { value: EmojiStyle; label: string }[] = [
  { value: "android", label: "Android (bundled Noto Color Emoji)" },
  { value: "twemoji", label: "Twemoji (bundled)" },
  { value: "windows", label: "Windows (system Segoe UI Emoji)" },
  { value: "custom", label: "Custom font file…" },
];

/** The bundled faces' @font-face aliases (styles.css) and the runtime one
 * (this module). Aliases are internal so a font installed on the user's
 * system under the upstream name neither shadows nor is shadowed. */
const ANDROID_FAMILY = "SPM Noto Color Emoji";
const TWEMOJI_FAMILY = "SPM Twemoji";
const CUSTOM_FAMILY = "SPM Custom Emoji";

/**
 * The tail every stack shares: the app's whole pre-SPM-17 emoji stack, minus
 * a head. A glyph missing from the chosen font falls through to the next
 * entry rather than to the text font — Windows would render text-default
 * emoji (☺ ❤ ✌ ...) as monochrome Symbol glyphs with the text font first
 * (owner decision, 2026-11-22). Keep in step with --font-emoji in styles.css.
 */
const EMOJI_FALLBACK_TAIL =
  '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", var(--font-ui)';

/**
 * The font-family stack each style draws with (SPM-17). Custom carries the
 * Android stack behind it: a custom file that cannot load leaves the family
 * unreferenced, so the ANDROID stack renders instead — the acceptance's
 * "fall back to Android" holds structurally at boot and after any switch.
 */
export const EMOJI_STYLE_STACKS: Record<EmojiStyle, string> = {
  android: `"${ANDROID_FAMILY}", ${EMOJI_FALLBACK_TAIL}`,
  twemoji: `"${TWEMOJI_FAMILY}", ${EMOJI_FALLBACK_TAIL}`,
  windows: EMOJI_FALLBACK_TAIL,
  custom: `"${CUSTOM_FAMILY}", "${ANDROID_FAMILY}", ${EMOJI_FALLBACK_TAIL}`,
};

/** The value set matches the Rust enum; only the app writes the config, and
 * anything it could not have written (an unknown value) is the default. */
export function parseEmojiStyle(value: string): EmojiStyle {
  return EMOJI_STYLE_CHOICES.find((c) => c.value === value)?.value ?? "android";
}

let preference: EmojiStyle = "android";
let customPath: string | null = null;
let problem: string | null = null;
let customFace: FontFace | null = null;
let customFacePath: string | null = null;

export function getEmojiStylePreference(): EmojiStyle {
  return preference;
}

export function getCustomEmojiFontPath(): string | null {
  return customPath;
}

/**
 * Why the custom style is not being used right now, or null when the chosen
 * style renders normally. Set when the file is gone or FontFace rejects it;
 * shown in Settings with the select left on Custom.
 */
export function emojiStyleProblem(): string | null {
  return problem;
}

/**
 * Load the custom style's face from its stored file. Throws when nothing is
 * set, the file is missing, or FontFace rejects the bytes. The same file
 * already loaded is kept: switching styles never re-reads it.
 */
async function loadCustomFace(path: string | null): Promise<void> {
  if (!path) throw new Error("no custom emoji font file is set");
  if (path === customFacePath && customFace) return;
  const bytes = await readCustomEmojiFont(path);
  const face = new FontFace(CUSTOM_FAMILY, bytes); // sniffs the container format
  try {
    await face.load();
  } catch (err) {
    // The web view's font engine (Chromium's OTS) rejects font FILES that
    // Windows' own renderer accepts: repacked or scraped "good" emoji fonts
    // commonly land here, and no webview-based app can draw them — the
    // rejection is the engine's, not a bug we can fix. Say that plainly
    // instead of surfacing Chromium's raw "Invalid font data in
    // ArrayBuffer" (owner, from the test, 2026-11-24).
    throw new Error(
      `${path} looks like a font, but the app's embedded web engine refused to load it. ` +
        `Other apps on this machine may render it, yet it cannot be used here — ` +
        `pick a different emoji font file. (${errorMessage(err)})`,
    );
  }
  document.fonts.add(face);
  if (customFace) document.fonts.delete(customFace); // one face under the alias
  customFace = face;
  customFacePath = path;
}

/**
 * Draw with `preference` without touching the stored config; boot seeds the
 * module's live state from the fetched AppState. A custom style whose file
 * cannot load renders the ANDROID stack instead and records why
 * (emojiStyleProblem); it never throws — boot must not die on a bad font.
 * Returns the style actually rendered.
 */
export async function applyEmojiStyle(
  next: EmojiStyle,
  nextCustomPath: string | null,
): Promise<EmojiStyle> {
  preference = next;
  customPath = nextCustomPath;
  problem = null;
  let effective = next;
  if (next === "custom") {
    try {
      await loadCustomFace(nextCustomPath);
    } catch (err) {
      problem = `The custom emoji font could not be loaded; showing Android emoji instead. ${errorMessage(err)}`;
      effective = "android";
    }
  }
  document.documentElement.style.setProperty(
    "--font-emoji",
    EMOJI_STYLE_STACKS[effective],
  );
  return effective;
}

/**
 * Choose a style from Settings: validate the custom FILE first, then
 * persist, then apply — a broken pick must not stick, and a choice that
 * cannot be persisted must not render. Non-custom styles persist as-is and
 * keep any stored custom path (switching back to Custom needs no re-pick).
 * Rejects on a broken file or a failed write for the caller's message line.
 */
export async function chooseEmojiStyle(
  style: EmojiStyle,
  nextCustomPath?: string,
): Promise<void> {
  if (style === "custom") {
    await loadCustomFace(nextCustomPath ?? customPath); // throws: nothing sticks
  }
  const state = await setEmojiStyle(style, nextCustomPath);
  await applyEmojiStyle(style, state.customEmojiFontPath);
}

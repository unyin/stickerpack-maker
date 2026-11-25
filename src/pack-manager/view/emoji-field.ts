// What the detail panel's Emoji String box and the Upload list's boxes share
// (SPEC §5): measuring an emoji glyph, the save-on-change / Enter-ends-the-edit
// wiring, and the copy button with its feedback.
import { icon } from "../../icons";
import { el } from "../../ui";

const COPY_TITLE = "Copy to clipboard";

/** Ordinary single-codepoint emoji drawn by the emoji font; no flags (two boxed letters in Segoe UI Emoji) or VS16 sequences (text-style base glyph). */
const EMOJI_WIDTH_SAMPLES = ["😀", "👍", "🤔", "😎"];

/** A measured glyph outside these multiples of the font size is not a real measurement (see measureEmojiGlyph). */
const EMOJI_GLYPH_MIN_RATIO = 0.8;
const EMOJI_GLYPH_MAX_RATIO = 1.6;

/**
 * The width of one emoji glyph in the given font, or null when it cannot be
 * measured. An emoji font draws its glyphs at one width, but the width differs
 * between fonts (Segoe UI Emoji, Noto, Twemoji), so measure a few ordinary
 * emoji in the box's own font and take the widest. A canvas that rejects the
 * font measures in its 10px default, so a glyph far narrower than the font
 * size (or far wider: it would overflow) is not a real measurement.
 */
export function measureEmojiGlyph(fontSize: string, fontFamily: string): number | null {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.font = `${fontSize} ${fontFamily}`;
  const widest = Math.max(...EMOJI_WIDTH_SAMPLES.map((e) => ctx.measureText(e).width));
  const size = parseFloat(fontSize);
  return widest >= size * EMOJI_GLYPH_MIN_RATIO && widest <= size * EMOJI_GLYPH_MAX_RATIO ? widest : null;
}

/**
 * An Emoji String box saves when it changes (blur), and Enter ends the edit
 * (the core strips every whitespace, so there are no line breaks to type).
 */
export function bindEmojiSave(input: HTMLTextAreaElement, save: (value: string) => void): void {
  input.addEventListener("change", () => save(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault(); // no line breaks in an Emoji String
      input.blur();
    }
  });
}

/** Briefly show the copy result: check icon and a green button on success, a red button on failure, and a screen-reader announcement. */
function copyFlash(button: HTMLButtonElement, status: HTMLElement): (text: string, ok: boolean) => void {
  let restore: ReturnType<typeof setTimeout> | undefined; // per button, like the one it restores
  return (text, ok) => {
    clearTimeout(restore); // a second click restarts the timer instead of leaving "Copied" stuck
    button.title = text;
    status.textContent = text;
    button.classList.toggle("copied", ok);
    button.classList.toggle("failed", !ok);
    button.replaceChildren(icon(ok ? "check" : "copy"));
    restore = setTimeout(() => {
      button.title = COPY_TITLE;
      status.textContent = "";
      button.classList.remove("copied", "failed");
      button.replaceChildren(icon("copy"));
    }, 1200);
  };
}

/**
 * The small square icon-only copy button of an Emoji String, and its polite
 * live region (the icon swap alone is invisible to screen readers): put both
 * in the page. `label` is the button's accessible name.
 */
export function copyButton(getText: () => string, label: string): { button: HTMLButtonElement; status: HTMLElement } {
  const button = el(
    "button",
    { class: "secondary pm-copy", type: "button", title: COPY_TITLE, "aria-label": label },
    icon("copy"),
  ) as HTMLButtonElement;
  const status = el("span", { class: "sr-only", role: "status" });
  const flash = copyFlash(button, status);
  button.addEventListener("click", () => {
    void navigator.clipboard.writeText(getText()).then(
      () => flash("Copied", true),
      () => flash("Copy failed", false),
    );
  });
  return { button, status };
}

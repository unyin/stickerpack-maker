// Emoji style choice (SPM-17): the value set, the parse tolerance and the
// per-style font-family stacks. The DOM application (the --font-emoji var
// flip, the custom FontFace load, the Settings card) is exercised by the
// smoke harness; these tests pin the pure contracts the stacks must keep.
import {
  EMOJI_STYLE_CHOICES,
  EMOJI_STYLE_STACKS,
  parseEmojiStyle,
} from "../src/emoji-style";

/** The tail every style shares: keep in step with --font-emoji in styles.css. */
const FALLBACK_TAIL =
  '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", var(--font-ui)';

describe("EMOJI_STYLE_CHOICES", () => {
  test("four choices, one per style, Android first as the default", () => {
    expect(EMOJI_STYLE_CHOICES.map((c) => c.value)).toEqual([
      "android",
      "twemoji",
      "windows",
      "custom",
    ]);
  });

  test("every choice has a label", () => {
    for (const choice of EMOJI_STYLE_CHOICES) {
      expect(choice.label.length).toBeGreaterThan(0);
    }
  });
});

describe("parseEmojiStyle", () => {
  test("round-trips every choice's value", () => {
    for (const { value } of EMOJI_STYLE_CHOICES) {
      expect(parseEmojiStyle(value)).toBe(value);
    }
  });

  test("anything the app could not have written means Android", () => {
    expect(parseEmojiStyle("")).toBe("android");
    expect(parseEmojiStyle("apple")).toBe("android");
    expect(parseEmojiStyle("Android")).toBe("android"); // case matters
  });
});

describe("EMOJI_STYLE_STACKS", () => {
  test("the bundled styles put their own font first", () => {
    expect(EMOJI_STYLE_STACKS.android.startsWith('"SPM Noto Color Emoji"')).toBe(true);
    expect(EMOJI_STYLE_STACKS.twemoji.startsWith('"SPM Twemoji"')).toBe(true);
  });

  test("Windows is the system stack: no bundled family in it", () => {
    expect(EMOJI_STYLE_STACKS.windows).toBe(FALLBACK_TAIL);
    expect(EMOJI_STYLE_STACKS.windows).not.toContain("SPM");
  });

  test("every style keeps the colour-first fallback tail", () => {
    // The pre-SPM-17 stack minus a head: emoji never fall to the text font
    // before every colour font missed (owner decision, 2026-11-22).
    for (const stack of Object.values(EMOJI_STYLE_STACKS)) {
      expect(stack).toContain(FALLBACK_TAIL);
      expect(stack.endsWith("var(--font-ui)")).toBe(true);
    }
  });

  test("Custom carries the whole Android stack behind it: a broken custom file falls back to Android structurally", () => {
    expect(EMOJI_STYLE_STACKS.custom).toBe(
      `"SPM Custom Emoji", ${EMOJI_STYLE_STACKS.android}`,
    );
  });
});

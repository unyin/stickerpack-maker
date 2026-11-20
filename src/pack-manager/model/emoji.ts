// Emoji String count and its live warning (SPEC §3: 1-20 emoji, warn only).
// Counts like the Rust core (stickers::emoji_count): grapheme clusters, so a
// ZWJ family, a flag or a skin-toned emoji counts once; whitespace never.
import limits from "../../shared/limits.json";

export const EMOJI_MIN = limits.emojiString.minEmoji;
export const EMOJI_MAX = limits.emojiString.maxEmoji;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function emojiCount(emojiString: string): number {
  let count = 0;
  for (const { segment } of graphemes.segment(emojiString)) {
    if (segment.trim() !== "") count += 1;
  }
  return count;
}

/** The warning for an Emoji String, or null when it holds 1-20 emoji. */
export function emojiWarning(emojiString: string): string | null {
  const count = emojiCount(emojiString);
  if (count < EMOJI_MIN) {
    return count === 0
      ? `No emoji yet: Telegram needs ${EMOJI_MIN}–${EMOJI_MAX}.`
      : `${count} emoji: Telegram needs at least ${EMOJI_MIN}.`;
  }
  if (count > EMOJI_MAX) return `${count} emoji: Telegram allows at most ${EMOJI_MAX}.`;
  return null;
}

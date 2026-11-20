// Emoji String count and its live warning (SPEC §3: warn only).
// Counts like the Rust core (stickers::emoji_count): grapheme clusters, so a
// ZWJ family, a flag or a skin-toned emoji counts once; whitespace never.
import limits from "../../shared/limits.json";
import type { Warning } from "../api";

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

/** The core's warning for an Emoji String (stickers::emoji_warning), or null when its count is in range. */
export function emojiCountWarning(emojiString: string): Warning | null {
  const count = emojiCount(emojiString);
  return count < EMOJI_MIN || count > EMOJI_MAX ? { kind: "emojiCount", count } : null;
}

/** The wording of that warning, or null when the Emoji String is fine. */
export function emojiWarning(emojiString: string): string | null {
  const warning = emojiCountWarning(emojiString);
  if (!warning) return null;
  const { count } = warning;
  if (count > EMOJI_MAX) return `${count} emoji: Telegram allows at most ${EMOJI_MAX}.`;
  return count === 0
    ? `No emoji yet: Telegram needs ${EMOJI_MIN}–${EMOJI_MAX}.`
    : `${count} emoji: Telegram needs at least ${EMOJI_MIN}.`;
}

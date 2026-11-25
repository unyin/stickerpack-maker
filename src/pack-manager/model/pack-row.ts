// The Pack list row's pure choices (SPEC §5, SPM-25): which picture stands for
// the pack, and where a dragged row lands. Pure, so testable without a webview.
import type { Box } from "./modes";

/** What a row's thumbnail cell shows (owner-approved tooltips, 2026-11-25). */
export type RowThumbnail =
  /** The pack's own thumbnail file. */
  | { kind: "own"; title: string }
  /** No thumbnail: the first sticker's preview in a dashed frame, as Telegram shows it. */
  | { kind: "first"; title: string; stickerId: number }
  /** The Missing art: the thumbnail file is Missing, or the first sticker (standing in) is. */
  | { kind: "missing"; title: string }
  /** No thumbnail and no stickers: a neutral placeholder. */
  | { kind: "none"; title: string };

/** The facts a row's thumbnail depends on. */
export interface RowThumbnailFacts {
  /** The pack's thumbnail file name, or null when it has none. */
  thumbnail: string | null;
  thumbnailMissing: boolean;
  firstSticker: { id: number; missing: boolean } | null;
}

export function rowThumbnail(facts: RowThumbnailFacts): RowThumbnail {
  if (facts.thumbnail !== null) {
    return facts.thumbnailMissing
      ? { kind: "missing", title: "The thumbnail file is Missing" }
      : { kind: "own", title: "Thumbnail" };
  }
  const first = facts.firstSticker;
  if (first === null) return { kind: "none", title: "No thumbnail and no stickers yet" };
  if (first.missing) {
    return { kind: "missing", title: "No thumbnail: Telegram shows the first sticker, which is Missing" };
  }
  return { kind: "first", title: "No thumbnail: Telegram shows the first sticker", stickerId: first.id };
}

/**
 * The insertion slot under a pointer at height `y` in a vertical list: slot i
 * means "before row i", slot n "after the last". Above a row's middle is
 * before it, below is after (so gaps, edges and the space past the ends all
 * resolve to the nearest sensible slot).
 */
export function rowSlotAt(rows: readonly Box[], y: number): number {
  const index = rows.findIndex((r) => y < r.top + r.height / 2);
  return index === -1 ? rows.length : index;
}

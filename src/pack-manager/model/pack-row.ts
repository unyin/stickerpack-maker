// The Pack list row's pure choices (SPEC §5, SPM-25): which picture stands for
// the pack. Pure, so testable without a webview.
import type { FirstSticker } from "../api";

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
  firstSticker: FirstSticker | null;
  /** Set when the pack's check failed: its files were never verified. */
  checkError: string | null;
}

export function rowThumbnail(facts: RowThumbnailFacts): RowThumbnail {
  // A failed check leaves the file facts unknown: show nothing it never verified.
  if (facts.checkError !== null) return { kind: "none", title: "The pack could not be checked" };
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

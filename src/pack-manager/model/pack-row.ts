// The Pack list row's pure choices (SPEC §5, SPM-25): which picture stands for
// the pack. Pure, so testable without a webview.
import type { FirstSticker, PackSummary } from "../api";

/** What a click on a row hit, and whether a drag just ended there. */
export interface RowClickFacts {
  /** The click landed on the grip or inside one of the row's buttons (title, Open in explorer, Delete). */
  onControl: boolean;
  /** The click is the one the browser fires after a drag ended inside the row. */
  endsDrag: boolean;
}

/**
 * Whether a click on a Pack list row opens its pack: anywhere on the row except
 * on a control (the grip and the buttons keep their own behaviour; the title
 * button opens by its own handler, so the row skips it too) and except the
 * click that ends a drag (a drag from the grip released inside the row makes
 * the browser click the row).
 */
export function rowClickOpens(facts: RowClickFacts): boolean {
  return !facts.onControl && !facts.endsDrag;
}

/**
 * The packs for a picker (Send to pack, the Editor's save target), alphabetical
 * by Title: case-insensitive, numbers in natural order ("Pack 2" before
 * "Pack 10"); ties fall to the Short Name, then the id. Returns a new array.
 */
export function packsAlphabetical<T extends Pick<PackSummary, "id" | "title" | "shortName">>(packs: readonly T[]): T[] {
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  return [...packs].sort((a, b) => cmp(a.title, b.title) || cmp(a.shortName, b.shortName) || a.id - b.id);
}

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

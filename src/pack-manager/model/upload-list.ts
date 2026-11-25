// The Upload list (SPEC §5, SPM-21; owner decisions 2026-11-25): which entries
// the dialog shows, when its header button is available, its notes, and the
// width that fits ten emoji per row. Pure, so it is testable without a webview.
import type { PackStatus, PackView, StickerView } from "../api";
import { MISSING_REASON, packSizeText } from "./messages";

/** Why the Upload list is unavailable, or null. A thumbnail alone is not a list: the pack must have stickers. */
export function uploadListBlocker(stickerCount: number): string | null {
  return stickerCount === 0 ? "The pack has no stickers yet" : null;
}

/** The enabled tooltip, per the §2 contract "Name (Shortcut) — one-line description". */
export const UPLOAD_LIST_TITLE = "Upload list… — Every sticker in order with its emoji, for uploading through @Stickers";

/** A Draft pack's reminder (owner-approved wording, 2026-11-25); null for a Live pack. */
export function draftNote(status: PackStatus): string | null {
  return status === "draft" ? "This pack is a Draft: press Go Live once @Stickers' /publish succeeds." : null;
}

/** The over-the-cap line as a warning: informational, blocks nothing (the same words as the pack banner). */
export function uploadSizeWarning(stickerCount: number): string | null {
  return packSizeText(stickerCount);
}

export const EXPLORER_TITLE = "Open in explorer — Show this file in File Explorer, selected";
export const DRAG_TITLE = "Drag to Telegram — Drag this file straight into the @Stickers chat";
export const THUMBNAIL_MISSING_REASON = "The thumbnail file is Missing; replace it first.";
export const THUMBNAIL_NOTE = "Thumbnail — no emoji";

/** One row of the list. The thumbnail, when the pack has one, is the last. */
export type UploadEntry =
  | { kind: "sticker"; sticker: StickerView }
  | { kind: "thumbnail"; missing: boolean };

export function uploadEntries(view: PackView): UploadEntry[] {
  const entries: UploadEntry[] = view.stickers.map((sticker) => ({ kind: "sticker", sticker }));
  if (view.pack.thumbnail) entries.push({ kind: "thumbnail", missing: view.thumbnailMissing || view.thumbnailFile === null });
  return entries;
}

export function entryMissing(entry: UploadEntry): boolean {
  return entry.kind === "thumbnail" ? entry.missing : entry.sticker.missing;
}

/** What replaces the description of a Missing entry's controls (§2), or null when its file is there. */
export function entryMissingReason(entry: UploadEntry): string | null {
  if (!entryMissing(entry)) return null;
  return entry.kind === "thumbnail" ? THUMBNAIL_MISSING_REASON : MISSING_REASON;
}

/** The accessible name of an entry's Open in explorer button (it has no text). */
export function explorerLabelFor(entry: UploadEntry): string {
  return entry.kind === "thumbnail" ? "Open thumbnail in explorer" : `Open #${entry.sticker.position} in explorer`;
}

/** Emoji per row the dialog is sized for (owner, 2026-11-25). */
export const EMOJI_PER_ROW = 10;

/**
 * The content width of an emoji box that fits EMOJI_PER_ROW per row: half a
 * glyph of slack, so ten fit and eleven do not (the detail panel's box uses
 * 5.5 glyphs for five, the same rule).
 */
export function emojiRowWidth(glyphWidth: number): number {
  return Math.ceil(glyphWidth * (EMOJI_PER_ROW + 0.5));
}

/**
 * The dialog's preferred width: the ten-per-row content width, plus
 * `boxChrome` (the box's padding, border and scrollbar gutter) and
 * `dialogChrome` (everything else across the dialog: its own padding and the
 * fixed columns). Only a preference: CSS caps it at the viewport, and the
 * emoji column is the one that shrinks.
 */
export function uploadDialogWidth(glyphWidth: number, boxChrome: number, dialogChrome: number): number {
  return emojiRowWidth(glyphWidth) + boxChrome + dialogChrome;
}

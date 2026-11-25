// The Upload list (SPEC §5, SPM-21; owner decisions 2026-11-25): which entries
// the dialog shows, when its header button is available, its notes, and the
// width that fits ten emoji per row. Pure, so it is testable without a webview.
import type { PackStatus, PackView, StickerFormat, StickerView } from "../api";
import { EMOJI_MAX, EMOJI_MIN } from "./emoji";
import { MISSING_REASON, thumbnailFormat } from "./messages";

/** Why the Upload list is unavailable, or null. A thumbnail alone is not a list: the pack must have stickers. */
export function uploadListBlocker(stickerCount: number): string | null {
  return stickerCount === 0 ? "The pack has no stickers yet" : null;
}

/** The enabled tooltip, per the §2 contract "Name (Shortcut) — one-line description". */
export const UPLOAD_LIST_TITLE = "Upload… — Every sticker in order with its emoji, for uploading through @Stickers";

/** The enabled tooltip while the pack is ready to go live: the header button is green and says why (owner, 2026-11-25). */
export const UPLOAD_READY_TITLE = `Upload… — Ready to go live: every sticker has its file and ${EMOJI_MIN}–${EMOJI_MAX} emoji`;

/** A Draft pack's reminder (owner-approved wording, 2026-11-25); null for a Live pack. */
export function draftNote(status: PackStatus): string | null {
  return status === "draft" ? "This pack is a Draft: press Go Live once @Stickers' /publish succeeds." : null;
}

export const EXPLORER_TITLE = "Open in explorer — Show this file in File Explorer, selected";
export const DRAG_TITLE = "Drag to Telegram — Drag this file straight into the @Stickers chat";
export const THUMBNAIL_MISSING_REASON = "The thumbnail file is Missing; replace it first.";
export const THUMBNAIL_NOTE = "Thumbnail — no emoji";

/** The file an entry stands for: what the app is asked to reveal, drag and preview (it resolves the path itself). */
export type FileTarget =
  | { kind: "sticker"; id: number; format: StickerFormat }
  | { kind: "thumbnail"; packId: number; format: StickerFormat };

/**
 * One row of the list, described once: its labels, Missing reason and file
 * target. The thumbnail, when the pack has one, is the last. `kind` is for
 * layout only (the thumbnail has no #N, copy button or emoji box).
 */
export type UploadEntry = {
  /** The accessible name of the entry's Open in explorer button (it has no text). */
  explorerLabel: string;
  /** What replaces the description of the entry's controls (§2) when its file is Missing, else null. */
  missingReason: string | null;
  imageAlt: string;
  target: FileTarget;
} & ({ kind: "sticker"; sticker: StickerView } | { kind: "thumbnail" });

export function uploadEntries(view: PackView): UploadEntry[] {
  const entries: UploadEntry[] = view.stickers.map((sticker) => ({
    kind: "sticker",
    sticker,
    explorerLabel: `Open #${sticker.position} in explorer`,
    missingReason: sticker.missing ? MISSING_REASON : null,
    imageAlt: `Sticker ${sticker.position}`,
    target: { kind: "sticker", id: sticker.id, format: sticker.format },
  }));
  if (view.pack.thumbnail) {
    const missing = view.thumbnailMissing || view.thumbnailFile === null;
    entries.push({
      kind: "thumbnail",
      explorerLabel: "Open thumbnail in explorer",
      missingReason: missing ? THUMBNAIL_MISSING_REASON : null,
      imageAlt: "Thumbnail",
      target: { kind: "thumbnail", packId: view.pack.id, format: thumbnailFormat(view.pack.thumbnail) },
    });
  }
  return entries;
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

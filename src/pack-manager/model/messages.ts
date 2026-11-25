// User-facing wording and the small rules behind it (SPEC §3, §5), kept
// pure so it is testable without a webview.
import limits from "../../shared/limits.json";
import { STICKER } from "../../editor/model/constraints";
import { KB } from "../../shared/units";
import { matchNames } from "../../shared/match-names";
import type { FileInfo, PackStatus, SendReport, StickerFormat, StickerView, Warning } from "../api";

export const PACK_MAX_STICKERS = limits.pack.maxStickers;

/** File size as people read it (KB of 1024 bytes, like the limits). */
export function formatBytes(bytes: number): string {
  if (bytes < KB) return `${bytes} bytes`;
  if (bytes < KB * KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / KB / KB).toFixed(1)} MB`;
}

/** A thumbnail file's format, from its name. */
export function thumbnailFormat(name: string | null): StickerFormat {
  return name?.endsWith(".webp") ? "webp" : "png";
}

export function dimensionsText(file: FileInfo | null): string {
  if (!file) return "—";
  return file.width !== null && file.height !== null ? `${file.width}×${file.height} px` : "unreadable";
}

export function statusLabel(status: PackStatus): string {
  return status === "live" ? "Live" : "Draft";
}

export function stickerCountText(n: number): string {
  return n === 1 ? "1 sticker" : `${n} stickers`;
}

export function packCountText(n: number, shown: number = n): string {
  const total = n === 1 ? "1 pack" : `${n} packs`;
  return shown === n ? total : `${shown} of ${total}`;
}

/** The Pack list's only item when the search matches nothing (SPEC §5). */
export function noPackMatchText(query: string): string {
  return `No packs match “${query.trim()}”.`;
}

/** Pack deletion confirmation, per status (SPEC §3). */
export function packDeleteMessage(title: string, status: PackStatus, stickerCount: number): string {
  if (status === "live") {
    return (
      `Delete “${title}” from this Library? Its local folder and ${stickerCountText(stickerCount)} are deleted ` +
      "from this computer only. The pack stays on Telegram: remove it there via @Stickers."
    );
  }
  return `Delete “${title}”? Its folder and ${stickerCountText(stickerCount)} are permanently deleted.`;
}

export const REVERT_TO_DRAFT_WARNING =
  "Mark this pack as Draft? Use this only if it does not exist on Telegram. " +
  "Draft unlocks the Short Name; a Live pack's Telegram short name can never change.";

export const GO_LIVE_CONFIRMATION =
  "Go Live with this pack? Use this only if it exists on Telegram. " +
  "Going Live locks the Short Name; a Live pack's Telegram short name can never change.";

export const SHORT_NAME_LOCKED = "Locked: a Live pack's Short Name cannot change (Telegram short names are permanent).";

/** The over-the-pack-cap banner (warn only, SPEC §3), or null under the cap. */
export function packSizeText(count: number, subject = "This pack"): string | null {
  return count > PACK_MAX_STICKERS
    ? `${subject} has ${count} stickers; Telegram allows at most ${PACK_MAX_STICKERS}. Remove ${count - PACK_MAX_STICKERS} before uploading.`
    : null;
}

export function warningText(warning: Warning | null, subject?: string): string | null {
  if (!warning) return null;
  return warning.kind === "packSize" ? packSizeText(warning.count, subject) : null;
}

/**
 * Why the toolbar's sticker count shows its warn state (SPEC §5), or null when
 * nothing is wrong: the over-120 text (`size`, from packSizeText) and/or a
 * short Missing count. It is the count's tooltip and accessible description.
 */
export function countWarningText(size: string | null, missing: number): string | null {
  const parts: string[] = [];
  if (size) parts.push(size);
  if (missing > 0) parts.push(`${missing} Missing.`);
  return parts.length ? parts.join(" ") : null;
}

export const MISSING_REASON = "This sticker's file is Missing; replace it first.";
export const MISSING_BANNER =
  "Missing: the file for this sticker is not in the pack folder (renamed, moved, or deleted outside the app). " +
  "Replace it with a valid sticker file, or delete the slot.";

/** Why Send to pack is unavailable for these stickers, or null (SPEC §5). */
export function sendBlocker(stickers: readonly StickerView[]): string | null {
  const missing = stickers.filter((s) => s.missing).length;
  if (missing === 0) return null;
  return stickers.length === 1
    ? MISSING_REASON
    : `${missing} of the selected stickers ${missing === 1 ? "is" : "are"} Missing; replace or deselect ${missing === 1 ? "it" : "them"} first.`;
}

/** Combined file size of the present files, and how many are Missing. */
export function combinedSize(stickers: readonly StickerView[]): string {
  const bytes = stickers.reduce((n, s) => n + (s.file?.bytes ?? 0), 0);
  const missing = stickers.filter((s) => s.missing).length;
  return missing === 0 ? formatBytes(bytes) : `${formatBytes(bytes)} (${missing} Missing)`;
}

export const STICKER_RULE =
  `PNG or WEBP, one side exactly ${STICKER.side} px and the other at most ${STICKER.side} px, at most ${STICKER.maxKilobytes} KB`;

export function importSummary(added: number, rejected: number): string {
  const parts = [];
  if (added > 0) parts.push(`Added ${stickerCountText(added)} without emoji; give each its Emoji String.`);
  if (rejected > 0) {
    parts.push(`${rejected === 1 ? "1 file is not a valid sticker" : `${rejected} files are not valid stickers`} (${STICKER_RULE}).`);
  }
  return parts.join(" ");
}

/** What a completed Send to pack did (SPEC §5: never silent). */
export function sendReportText(report: SendReport, targetTitle: string): string {
  const n = stickerCountText(report.copied.length);
  const verb = report.originalsDeleted ? "Moved" : "Copied";
  const parts = [`${verb} ${n} to “${targetTitle}”.`];
  if (report.unfinished) parts.push(`Not finished: ${report.unfinished}.`);
  const size = warningText(report.targetSizeWarning, "The target pack");
  if (size) parts.push(size);
  return parts.join(" ");
}

/**
 * The pack picker's type-to-search (Save and Send to pack): case-insensitive,
 * Titles starting with the query first, then Titles or Short Names containing it.
 */
export function matchPacks<P extends { title: string; shortName: string }>(packs: readonly P[], query: string): readonly P[] {
  return matchNames(packs, query, (p) => p.title, (p) => p.shortName);
}

/** The Editor's saved-note link found its sticker gone between its check and the pack view (a rare race). */
export const REVEAL_GONE = "That sticker is no longer in this pack.";

/** The Editor's saved-note link arrived while a pack action was still working. */
export const REVEAL_BUSY = "Another action was still working, so the saved sticker was not selected: use the link again.";

/** The last path segment, for listing dropped files. */
export function fileNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
}

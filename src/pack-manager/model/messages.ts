// User-facing wording and the small rules behind it (SPEC §3, §5), kept
// pure so it is testable without a webview.
import limits from "../../shared/limits.json";
import { STICKER } from "../../editor/model/constraints";
import type { FileInfo, PackStatus, SendReport, StickerView, Warning } from "../api";

export const PACK_MAX_STICKERS = limits.pack.maxStickers;
const KB = 1024;

/** File size as people read it (KB of 1024 bytes, like the limits). */
export function formatBytes(bytes: number): string {
  if (bytes < KB) return `${bytes} bytes`;
  if (bytes < KB * KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / KB / KB).toFixed(1)} MB`;
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

export const LIVE_TO_DRAFT_WARNING =
  "Mark this pack as Draft? Use this only if it does not exist on Telegram. " +
  "Draft unlocks the Short Name; a Live pack's Telegram short name can never change.";

export const SHORT_NAME_LOCKED = "Locked: a Live pack's Short Name cannot change (Telegram short names are permanent).";

/** The 120-sticker banner (warn only, SPEC §3), or null under the cap. */
export function packSizeText(count: number): string | null {
  return count > PACK_MAX_STICKERS
    ? `This pack has ${count} stickers; Telegram allows at most ${PACK_MAX_STICKERS}. Remove ${count - PACK_MAX_STICKERS} before uploading.`
    : null;
}

export function warningText(warning: Warning | null): string | null {
  if (!warning) return null;
  return warning.kind === "packSize" ? packSizeText(warning.count) : null;
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
  if (rejected > 0) parts.push(`${rejected} file${rejected === 1 ? " was" : "s were"} not valid stickers (${STICKER_RULE}).`);
  return parts.join(" ");
}

/** What a completed Send to pack did (SPEC §5: never silent). */
export function sendReportText(report: SendReport, targetTitle: string): string {
  const n = stickerCountText(report.copied.length);
  const verb = report.originalsDeleted ? "Moved" : "Copied";
  const parts = [`${verb} ${n} to “${targetTitle}”.`];
  if (report.unfinished) parts.push(`Not finished: ${report.unfinished}.`);
  const size = warningText(report.targetSizeWarning);
  if (size) parts.push(size.replace("This pack", "The target pack"));
  return parts.join(" ");
}

/** Case-insensitive search over Title and Short Name for the Send dialog. */
export function matchesSearch(pack: { title: string; shortName: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || pack.title.toLowerCase().includes(q) || pack.shortName.toLowerCase().includes(q);
}

/** The last path segment, for listing dropped files. */
export function fileNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
}

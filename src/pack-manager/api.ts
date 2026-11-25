// Typed wrappers around the Pack Manager's Rust commands
// (src-tauri/src/pack_commands.rs). Names and camelCase fields must stay in
// sync with the Rust side (serde rename_all = "camelCase").
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type PackStatus = "draft" | "live";
export type StickerFormat = "png" | "webp";

export interface Pack {
  id: number;
  title: string;
  shortName: string;
  status: PackStatus;
  thumbnail: string | null;
  folderRenameFrom: string | null;
}

export interface PackSummary extends Pack {
  stickerCount: number;
}

/** The first sticker of a pack, which stands in for a missing thumbnail. */
export interface FirstSticker {
  id: number;
  format: StickerFormat;
  missing: boolean;
}

/** One pack as the Pack list shows it: plain facts from the full open check (SPM-25). */
export interface PackListEntry extends Pack {
  stickerCount: number;
  missingCount: number;
  thumbnailMissing: boolean;
  /** Every sticker's Emoji String, in position order. */
  emojiStrings: string[];
  /** The first sticker, which stands in for a missing thumbnail; null when the pack is empty. */
  firstSticker: FirstSticker | null;
  /** Set when the pack's check failed; the other facts are then the database's alone. */
  checkError: string | null;
}

/** A warn-only condition (stickers::Warning, tagged by `kind`). */
export type Warning = { kind: "emojiCount"; count: number } | { kind: "packSize"; count: number };

/** A present file: its size, and its pixel size when readable. */
export interface FileInfo {
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface Sticker {
  id: number;
  packId: number;
  position: number;
  fileName: string;
  format: StickerFormat;
  emojiString: string;
}

export interface StickerView extends Sticker {
  missing: boolean;
  emojiWarning: Warning | null;
  /** null when Missing. */
  file: FileInfo | null;
}

export interface PackView {
  pack: Pack;
  stickers: StickerView[];
  thumbnailMissing: boolean;
  thumbnailFile: FileInfo | null;
  packSizeWarning: Warning | null;
}

export interface FileError {
  path: string;
  reason: string;
}

export interface ImportResult {
  view: PackView;
  addedIds: number[];
  rejected: FileError[];
}

export interface LeftoverFolder {
  path: string;
  reason: string;
}

export interface SendReport {
  copied: Sticker[];
  originalsDeleted: boolean;
  unfinished: string | null;
  targetSizeWarning: Warning | null;
}

/** What a failed Send to pack rejects with (stickers::SendFailure). */
export interface SendFailure {
  message: string;
  fileErrors: FileError[];
}

export function isSendFailure(err: unknown): err is SendFailure {
  return typeof err === "object" && err !== null && typeof (err as SendFailure).message === "string" &&
    Array.isArray((err as SendFailure).fileErrors);
}

/** Database only, in the stored order: for the pack pickers. */
export const listPacks = () => invoke<PackSummary[]>("list_packs");
/** The Pack list's rows: every pack gets the full open check, in the stored order (SPEC §4, §5). */
export const listPackFacts = () => invoke<PackListEntry[]>("list_pack_facts");
/** Reorder a pack to 1-based `newPosition` in the Pack list (1 = top); display order only. */
export const reorderPack = (packId: number, newPosition: number) => invoke<void>("reorder_pack", { packId, newPosition });
export const suggestShortName = (title: string) => invoke<string>("suggest_short_name", { title });
/** `shortName` null = auto-derive from the Title (made unique). */
export const createPack = (title: string, shortName: string | null) =>
  invoke<Pack>("create_pack", { title, shortName });
export const deletePack = (packId: number) => invoke<LeftoverFolder | null>("delete_pack", { packId });
/** Open or refresh: runs recovery and desync detection (SPEC §4). */
export const openPack = (packId: number) => invoke<PackView>("open_pack", { packId });
/** The pack view after an operation: recovery, but no Missing scan (SPEC §4). */
export const loadPackView = (packId: number) => invoke<PackView>("load_pack_view", { packId });
export const setPackTitle = (packId: number, title: string) => invoke<Pack>("set_pack_title", { packId, title });
export const setPackShortName = (packId: number, shortName: string) =>
  invoke<Pack>("set_pack_short_name", { packId, shortName });
export const setPackStatus = (packId: number, status: PackStatus) =>
  invoke<Pack>("set_pack_status", { packId, status });
export const reorderSticker = (stickerId: number, newPosition: number) =>
  invoke<PackView>("reorder_sticker", { stickerId, newPosition });
export const deleteStickers = (packId: number, stickerIds: number[]) =>
  invoke<PackView>("delete_stickers", { packId, stickerIds });
export const setEmojiString = (stickerId: number, emojiString: string) =>
  invoke<Sticker>("set_emoji_string", { stickerId, emojiString });
export const importStickers = (packId: number, paths: string[]) =>
  invoke<ImportResult>("import_stickers", { packId, paths });
/** Resolves when the file is a valid sticker; rejects with the reason. */
export const checkStickerFile = (path: string) => invoke<void>("check_sticker_file", { path });
export const replaceSticker = (stickerId: number, path: string) =>
  invoke<PackView>("replace_sticker", { stickerId, path });
/** Rejects with a SendFailure when nothing (or only the copy) happened. */
export const sendToPack = (stickerIds: number[], targetPackId: number, deleteOriginals: boolean) =>
  invoke<SendReport>("send_to_pack", { stickerIds, targetPackId, deleteOriginals });
export const stickerFilePath = (stickerId: number) => invoke<string>("sticker_file_path", { stickerId });
export const revealSticker = (stickerId: number) => invoke<void>("reveal_sticker", { stickerId });
export const revealThumbnail = (packId: number) => invoke<void>("reveal_thumbnail", { packId });
/** The pack view after deleting the thumbnail (row cleared, file removed). */
export const deleteThumbnail = (packId: number) => invoke<PackView>("delete_thumbnail", { packId });
/**
 * Start a native OS file drag of the sticker's file (Upload list, SPM-21).
 * Resolves when the drag ends, dropped or cancelled. Rust resolves the id to
 * the path, so the webview can never name a file to drag.
 */
export const dragSticker = (stickerId: number) => invoke<void>("drag_sticker", { stickerId });
/** The same for the pack's thumbnail file. */
export const dragThumbnail = (packId: number) => invoke<void>("drag_thumbnail", { packId });
export const revealPack = (packId: number) => invoke<void>("reveal_pack", { packId });
export const stickerImage = (stickerId: number) => invoke<ArrayBuffer>("sticker_image", { stickerId });
export const thumbnailImage = (packId: number) => invoke<ArrayBuffer>("thumbnail_image", { packId });

/** Extensions a sticker file may have (SPEC §7). */
export const STICKER_EXTENSIONS = ["png", "webp"];

/** Native picker for sticker files. Returns [] when cancelled. */
export async function pickStickerFiles(multiple: boolean, title: string): Promise<string[]> {
  const selected = await open({
    directory: false,
    multiple,
    title,
    filters: [{ name: "Stickers (PNG, WEBP)", extensions: STICKER_EXTENSIONS }],
  });
  if (selected === null) return [];
  return Array.isArray(selected) ? selected : [selected];
}

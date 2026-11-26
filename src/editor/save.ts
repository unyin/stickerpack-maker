// The save pipeline's rules and wording (SPEC §6 Save, SPM-10), kept pure so
// they are testable without a webview. Rust flattens, encodes and writes
// (editor_save_image); this decides when Save is blocked, runs the owner's
// size flow (CMT-144) and words what happened.
import { formatBytes } from "../pack-manager/model/messages";
import type { Pack, PackView, Sticker } from "../pack-manager/api";
import { stickerOrigin, type StickerOrigin } from "../shared/sticker-origin";
import { constraintStatus, readoutText, type ConstraintSet } from "./model/constraints";
import type { Size } from "./model/document";

export type SaveFormat = "png" | "webp";

/** Where a save goes; mirrors `SaveTarget` in src-tauri/src/save_commands.rs. */
export type SaveTarget =
  /** A new sticker at the end of the pack. */
  | { readonly kind: "append"; readonly packId: number }
  /**
   * An existing sticker's image, keeping its position and Emoji String
   * (the edited sticker; SPM-11's Replace too).
   */
  | { readonly kind: "replace"; readonly stickerId: number }
  /** The pack's thumbnail slot (SPM-12): the pack's unnumbered thumbnail file. */
  | { readonly kind: "thumbnail"; readonly packId: number };

/** The origin sticker as it is now: where it sits and its format. */
export interface OriginNow {
  readonly position: number;
  readonly packTitle: string;
  readonly format: SaveFormat;
}

/** The origin sticker's lookup: where it is now, or why it cannot be replaced. */
export type OriginLookup = OriginNow | { readonly gone: string };

/**
 * Find the origin sticker in its pack as it is now (`view` null: the pack
 * could not be read, e.g. deleted). It may have moved within its pack
 * (Reorder): that is still the same sticker. Gone (deleted, moved to another
 * pack, another Library): why it cannot be replaced.
 */
export function resolveOrigin(origin: StickerOrigin, view: PackView | null): OriginLookup {
  if (origin.otherLibrary) {
    return {
      gone: `Sticker #${origin.position} of “${origin.packTitle}” belongs to the Library used before, so it cannot be replaced. Save it as a new sticker instead.`,
    };
  }
  const sticker = view?.stickers.find((s) => s.id === origin.stickerId);
  if (!view || !sticker) {
    return {
      gone: `Sticker #${origin.position} of “${origin.packTitle}” no longer exists (it was deleted or moved since it was opened), so it cannot be replaced. Save it as a new sticker instead.`,
    };
  }
  return { position: sticker.position, packTitle: view.pack.title, format: sticker.format };
}

/**
 * Whether closing the session asks about its gone origin sticker (owner
 * decision 2026-11-23): a CLEAN session whose origin no longer exists in
 * the Library warns before closing throws the last copy of the image away.
 * `now` is the same lookup the save dialog's Replace option uses
 * (originNow), so the two can never disagree. A dirty session never gets
 * here: its own unsaved-changes warning has already decided.
 */
export function originGoneCloseWarning(origin: StickerOrigin | null, now: OriginLookup): boolean {
  return origin !== null && "gone" in now;
}

/** The replace option's label: "Replace #4 in “Cats”". */
export function replaceLabel(now: OriginNow): string {
  return `Replace #${now.position} in “${now.packTitle}”`;
}

/**
 * The session's origin after a save (design decision 2026-11-22): a replace
 * keeps the same sticker; a save as a new sticker makes the session edit
 * that new sticker, so the next save replaces it rather than adding another.
 */
export function originAfterSave(saved: Saved, packTitle: string): StickerOrigin {
  return stickerOrigin(saved.sticker, packTitle);
}

/** What the save command did; mirrors `SaveOutcome` in save_commands.rs. */
export type SaveOutcome =
  | { readonly kind: "saved"; readonly sticker: Sticker; readonly bytes: number; readonly quality: number | null }
  | { readonly kind: "savedThumbnail"; readonly pack: Pack; readonly bytes: number; readonly quality: number | null }
  | { readonly kind: "tooLarge"; readonly format: SaveFormat; readonly bytes: number; readonly maxKilobytes: number };

export type TooLarge = Extract<SaveOutcome, { kind: "tooLarge" }>;
export type Saved = Extract<SaveOutcome, { kind: "saved" }>;
export type SavedThumbnail = Extract<SaveOutcome, { kind: "savedThumbnail" }>;

export const FORMAT_LABEL: Record<SaveFormat, string> = { png: "PNG", webp: "WEBP" };

/**
 * Why Save is blocked (SPEC §6: hard-blocked, no warn-and-proceed), or null
 * when the canvas meets the active constraint set. The file-size half of
 * the rule is checked by Rust on the encoded bytes.
 */
export function saveBlocker(canvas: Size, set: ConstraintSet): string | null {
  if (constraintStatus(canvas, set).ok) return null;
  const fit = `Fit in ${set.side}`;
  const fix = set.square ? `${fit} fixes it.` : `${fit} or Long side ${set.side} fixes it.`;
  return `Save is blocked: ${readoutText(canvas, set)}. ${fix}`;
}

/**
 * Why a save is refused before the save dialog opens (owner decision
 * 2026-11-23): a pixel-changing operation is still in progress — a refine
 * stroke (Erase/Restore, SPM-7) or a warp gesture (Warp, SPM-8) — and its
 * pixels are painted live but not in the model yet, so the dialog would
 * snapshot the document without them — and the operation's release would
 * commit them under it. The operation ends first.
 */
export const SAVE_MID_STROKE =
  "Save is blocked: an Erase, Restore or Warp operation is still in progress. Finish the operation first, then save.";

/**
 * Why this save attempt is refused before the save dialog opens, or null
 * when the dialog may open: a mid-press stroke (Erase/Restore, SPM-7; Warp,
 * SPM-8) refuses even a canvas that passes the rule; otherwise the canvas
 * rule (SPEC §6: hard-blocked) decides. Both of the Editor's save entry
 * points — the Save… button and Ctrl+S — go through here, so a stroke in
 * progress never reaches the dialog.
 */
export function saveRefusal(midStroke: boolean, canvas: Size, set: ConstraintSet): string | null {
  return midStroke ? SAVE_MID_STROKE : saveBlocker(canvas, set);
}

/** How the save went, for the Editor. */
export type SaveResult =
  /** Written: the sticker or the pack's thumbnail, as the target decided. */
  | { readonly kind: "saved"; readonly outcome: Saved | SavedThumbnail }
  /** Too large as PNG and the user kept PNG: back to the save dialog. */
  | { readonly kind: "declined"; readonly outcome: TooLarge }
  /** Too large even as WEBP at its lowest quality: back to the Editor. */
  | { readonly kind: "exhausted"; readonly outcome: TooLarge };

export interface SaveFlow {
  /** Flatten, encode and write as `format`; resolves with what happened. */
  save(format: SaveFormat): Promise<SaveOutcome>;
  /** The PNG is over the cap: resolves true to save as WEBP instead. */
  offerWebp(outcome: TooLarge): Promise<boolean>;
}

/**
 * The size flow (owner decision 2026-11-21, CMT-144): save in the chosen
 * format; a PNG over the cap offers WEBP; a WEBP over the cap even at the
 * lowest quality is exhausted. Errors (a refused size, a Library failure)
 * reject.
 */
export async function runSave(format: SaveFormat, flow: SaveFlow): Promise<SaveResult> {
  let outcome = await flow.save(format);
  if (outcome.kind === "tooLarge" && outcome.format === "png") {
    if (!(await flow.offerWebp(outcome))) return { kind: "declined", outcome };
    outcome = await flow.save("webp");
  }
  if (outcome.kind === "tooLarge") return { kind: "exhausted", outcome };
  return { kind: "saved", outcome };
}

/** "734.2 KB, over the 512 KB limit". */
function overCap(outcome: TooLarge): string {
  return `${formatBytes(outcome.bytes)}, over the ${outcome.maxKilobytes} KB limit`;
}

/** The body of the "Too large as PNG" question. */
export function pngTooLargeText(outcome: TooLarge): string[] {
  return [
    `As PNG this image is ${overCap(outcome)}, and PNG has no quality setting to shrink it.`,
    "Save it as WEBP instead? WEBP keeps every pixel when that fits, and otherwise lowers the quality only as far as the limit needs.",
  ];
}

/** The save dialog's line after the user kept PNG. */
export function declinedText(outcome: TooLarge): string {
  return `Not saved: as PNG it is ${overCap(outcome)}. Choose WEBP, or simplify the image.`;
}

/** Title of the "even WEBP is too large" dialog. */
export const EXHAUSTED_TITLE = "Too large even as WEBP";

/**
 * Even WEBP at its lowest quality is over the cap: the owner's own words
 * (decision 2026-11-22, CMT-241), with the cap the save was held to (the
 * active constraint set's, or the debug override's in a dev build).
 */
export function exhaustedText(maxKilobytes: number): string {
  return (
    "Congratulations, you've somehow managed to make an image so weird that even WEBP at its lowest " +
    `quality won't save below ${maxKilobytes} KB. Go back to the editor and try to fix it, or fuck it ` +
    "all and start over. Up to you."
  );
}

/** The saved note's link to the sticker: visible text and accessible name. */
export function showStickerLink(sticker: Sticker, packTitle: string): { text: string; label: string } {
  // The accessible name starts with the visible text (WCAG 2.5.3, label in name).
  return { text: "Show in Pack Manager", label: `Show in Pack Manager: sticker #${sticker.position} of “${packTitle}”` };
}

/**
 * Clicking the saved note's link when the sticker is gone (owner decision
 * 2026-11-22): deleted or moved since, or saved into the Library used before.
 */
export function stickerGoneText(position: number, packTitle: string, otherLibrary = false): string {
  const why = otherLibrary ? "it was saved into the Library used before" : "it was deleted or moved since it was saved";
  return `Sticker #${position} of “${packTitle}” no longer exists (${why}).`;
}

/** The neutral note after a save: which file, where, and the emoji still to add. */
export function savedText(outcome: Saved, packTitle: string, target: SaveTarget): string {
  const { sticker } = outcome;
  const quality = outcome.quality === null ? "" : `, WEBP quality ${outcome.quality}`;
  const size = `${formatBytes(outcome.bytes)}${quality}`;
  if (target.kind === "replace") return `Replaced #${sticker.position} in “${packTitle}”.`;
  const emoji = sticker.emojiString === "" ? " Give it an Emoji String in the Emoji tab or the Pack Manager." : "";
  return `Saved as ${sticker.fileName}, sticker #${sticker.position} of “${packTitle}” (${size}).${emoji}`;
}

/** The neutral note after a thumbnail save: which file, which pack, and the size. */
export function thumbnailSavedText(pack: Pack, bytes: number, quality: number | null): string {
  const q = quality === null ? "" : `, WEBP quality ${quality}`;
  return `Thumbnail of “${pack.title}” saved as ${pack.thumbnail} (${formatBytes(bytes)}${q}).`;
}

/** The saved note's link to the thumbnail: visible text and accessible name. */
export function showThumbnailLink(packTitle: string): { text: string; label: string } {
  // The accessible name starts with the visible text (WCAG 2.5.3, label in name).
  return { text: "Show in Pack Manager", label: `Show in Pack Manager: thumbnail of “${packTitle}”` };
}

/** Clicking the saved note's link when the pack is gone (deleted, or another Library). */
export function thumbnailGoneText(packTitle: string, otherLibrary = false): string {
  const why = otherLibrary ? "it belongs to the Library used before" : "it was deleted since the thumbnail was saved";
  return `The pack “${packTitle}” no longer exists (${why}).`;
}

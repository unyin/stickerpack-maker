// The save pipeline's rules and wording (SPEC §6 Save, SPM-10), kept pure so
// they are testable without a webview. Rust flattens, encodes and writes
// (editor_save_image); this decides when Save is blocked, runs the owner's
// size flow (CMT-144) and words what happened.
import { formatBytes } from "../pack-manager/model/messages";
import type { Sticker } from "../pack-manager/api";
import { constraintStatus, readoutText, type ConstraintSet } from "./model/constraints";
import type { Size } from "./model/document";

export type SaveFormat = "png" | "webp";

/** Where a save goes; mirrors `SaveTarget` in src-tauri/src/save_commands.rs. */
export type SaveTarget =
  /** A new sticker at the end of the pack. */
  | { readonly kind: "append"; readonly packId: number }
  /** An existing sticker's image, keeping its position and Emoji String (SPM-11). */
  | { readonly kind: "replace"; readonly stickerId: number };

/** What the save command did; mirrors `SaveOutcome` in save_commands.rs. */
export type SaveOutcome =
  | { readonly kind: "saved"; readonly sticker: Sticker; readonly bytes: number; readonly quality: number | null }
  | { readonly kind: "tooLarge"; readonly format: SaveFormat; readonly bytes: number; readonly maxKilobytes: number };

export type TooLarge = Extract<SaveOutcome, { kind: "tooLarge" }>;
export type Saved = Extract<SaveOutcome, { kind: "saved" }>;

export const FORMAT_LABEL: Record<SaveFormat, string> = { png: "PNG", webp: "WEBP" };

/**
 * Why Save is blocked (SPEC §6: hard-blocked, no warn-and-proceed), or null
 * when the canvas meets the active constraint set. The file-size half of
 * the rule is checked by Rust on the encoded bytes.
 */
export function saveBlocker(canvas: Size, set: ConstraintSet): string | null {
  if (constraintStatus(canvas, set).ok) return null;
  const fit = `Fit to ${set.side}×${set.side}`;
  const fix = set.square ? `${fit} fixes it.` : `${fit} or Longest side ${set.side} fixes it.`;
  return `Save is blocked: ${readoutText(canvas, set)}. ${fix}`;
}

/** How the save went, for the Editor. */
export type SaveResult =
  | { readonly kind: "saved"; readonly outcome: Saved }
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

/** The neutral note after a save: which file, where, and the emoji still to add. */
export function savedText(outcome: Saved, packTitle: string, target: SaveTarget): string {
  const { sticker } = outcome;
  const quality = outcome.quality === null ? "" : `, WEBP quality ${outcome.quality}`;
  const size = `${formatBytes(outcome.bytes)}${quality}`;
  if (target.kind === "replace") return `Saved over sticker #${sticker.position} (${sticker.fileName}) in “${packTitle}” (${size}).`;
  const emoji = sticker.emojiString === "" ? " Give it an Emoji String in the Pack Manager." : "";
  return `Saved as ${sticker.fileName}, sticker #${sticker.position} of “${packTitle}” (${size}).${emoji}`;
}

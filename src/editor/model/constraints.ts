// The constraint sets a session is edited against (SPEC §6-7). Their values
// have one definition, src/shared/limits.json, which Rust reads too (build.rs).
import limits from "../../shared/limits.json";
import type { Size } from "./document";

export interface ConstraintSet {
  readonly mode: "sticker" | "thumbnail";
  /**
   * The target side: Sticker mode needs the longest side exactly this,
   * Thumbnail mode exactly this square. Sizing tools 1 and 2 use it.
   */
  readonly side: number;
  /** Largest saved file, in KB of 1024 bytes. */
  readonly maxKilobytes: number;
  /**
   * The canvas must be exactly `side` square, so only Fit can satisfy it:
   * "Longest side" is greyed out (SPEC §6).
   */
  readonly square: boolean;
}

/** Sticker mode, the default: longest side exactly the sticker side, file within the sticker cap. */
export const STICKER: ConstraintSet = {
  mode: "sticker",
  side: limits.sticker.side,
  maxKilobytes: limits.sticker.maxKilobytes,
  square: false,
};

/** Thumbnail mode (a pack's thumbnail sessions, SPM-12): exactly the thumbnail side square, file within its cap. */
export const THUMBNAIL: ConstraintSet = {
  mode: "thumbnail",
  side: limits.thumbnail.side,
  maxKilobytes: limits.thumbnail.maxKilobytes,
  square: true,
};

/** The square canvas a session in this mode starts with (SPEC §6). */
export function startCanvas(set: ConstraintSet): Size {
  return { width: set.side, height: set.side };
}

/** One canvas side that misses the set's target: signed px, positive = over. */
export interface SideOff {
  readonly side: "longest side" | "width" | "height";
  readonly by: number;
}

/**
 * How the canvas measures against the set (the live readout, SPEC §6).
 * Sticker mode checks the longest side, Thumbnail mode width and height.
 */
export interface ConstraintStatus {
  readonly ok: boolean;
  /** The sides that miss the target; empty when `ok`. */
  readonly off: readonly SideOff[];
}

export function constraintStatus(canvas: Size, set: ConstraintSet): ConstraintStatus {
  const checked: SideOff[] = set.square
    ? [
        { side: "width", by: canvas.width - set.side },
        { side: "height", by: canvas.height - set.side },
      ]
    : [{ side: "longest side", by: Math.max(canvas.width, canvas.height) - set.side }];
  const off = checked.filter((s) => s.by !== 0);
  return { ok: off.length === 0, off };
}

/** What the set requires, in words: "longest side 512" or "100×100". */
function requirement(set: ConstraintSet): string {
  return set.square ? `${set.side}×${set.side}` : `longest side ${set.side}`;
}

/**
 * The live readout's text: the canvas size, then whether it meets the set
 * or how far off it is, e.g. "600×400 px · needs longest side 512: 88 px over".
 */
export function readoutText(canvas: Size, set: ConstraintSet): string {
  return readoutTextFor(canvas, set, constraintStatus(canvas, set));
}

function readoutTextFor(canvas: Size, set: ConstraintSet, status: ConstraintStatus): string {
  const size = `${canvas.width}×${canvas.height} px`;
  if (status.ok) return `${size} · ${set.mode} size OK (${requirement(set)})`;
  const parts = status.off.map((s) => {
    const amount = `${Math.abs(s.by)} px ${s.by > 0 ? "over" : "under"}`;
    return set.square ? `${s.side} ${amount}` : amount;
  });
  return `${size} · needs ${requirement(set)}: ${parts.join(", ")}`;
}

/**
 * Font sizes a text layer may have, in px (SPM-9). Resizing a text layer on
 * the canvas scales it beyond these; the size field stays within them.
 */
export const TEXT_FONT_SIZE = {
  min: limits.text.minFontSize,
  max: limits.text.maxFontSize,
} as const;

/** The readout's text and whether the canvas meets the set, from one status computation. */
export function readoutStatus(canvas: Size, set: ConstraintSet): { text: string; ok: boolean } {
  const status = constraintStatus(canvas, set);
  return { text: readoutTextFor(canvas, set, status), ok: status.ok };
}

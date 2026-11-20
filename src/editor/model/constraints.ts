// The constraint sets a session is edited against (SPEC §6-7). Their values
// have one definition, src/shared/limits.json, which Rust reads too (build.rs).
import limits from "../../shared/limits.json";

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

/** Thumbnail mode (not wired in the UI yet): exactly the thumbnail side square, file within its cap. */
export const THUMBNAIL: ConstraintSet = {
  mode: "thumbnail",
  side: limits.thumbnail.side,
  maxKilobytes: limits.thumbnail.maxKilobytes,
  square: true,
};

/** The square canvas a session in this mode starts with (SPEC §6). */
export function startCanvas(set: ConstraintSet): { readonly width: number; readonly height: number } {
  return { width: set.side, height: set.side };
}

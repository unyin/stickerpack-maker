// The constraint sets a session is edited against (SPEC §6-7). Their values
// have one definition, src/shared/limits.json, which Rust reads too (build.rs).
import limits from "../../shared/limits.json";

/** Bytes in a KB, as the limits count them. */
export const KB = 1024;

export interface ConstraintSet {
  readonly mode: "sticker" | "thumbnail";
  /**
   * The target side: Sticker mode needs the longest side exactly this,
   * Thumbnail mode exactly this square. Sizing tools 1 and 2 use it.
   */
  readonly side: number;
  /** Largest saved file, in KB of 1024 bytes. */
  readonly maxKilobytes: number;
}

/** Sticker mode, the default: longest side 512, at most 512 KB. */
export const STICKER: ConstraintSet = {
  mode: "sticker",
  side: limits.sticker.side,
  maxKilobytes: limits.sticker.maxKilobytes,
};

/** Thumbnail mode (not wired in the UI yet): exactly 100×100, at most 128 KB. */
export const THUMBNAIL: ConstraintSet = {
  mode: "thumbnail",
  side: limits.thumbnail.side,
  maxKilobytes: limits.thumbnail.maxKilobytes,
};

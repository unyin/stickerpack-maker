// Text tool rules (SPEC §6, SPM-9): the default style, validation, and the
// font a session starts with. Rendering and measuring happen in Rust
// (src-tauri/src/editor/text.rs); this file has no Konva and no DOM.
import { TEXT_FONT_SIZE } from "./constraints";

/** A new text layer's size and colour until the user picks others. */
export const DEFAULT_FONT_SIZE = 64;
export const DEFAULT_TEXT_COLOR = "#000000";

/**
 * Families tried, in order, for the first text of a session: common on
 * Windows first (the target), then Linux. Otherwise the first installed one.
 */
const PREFERRED_FAMILIES = ["Arial", "Segoe UI", "Calibri", "DejaVu Sans", "Liberation Sans", "Noto Sans", "Ubuntu"];

/** The font a session's text starts with, or null when no font is installed. */
export function defaultFontFamily(installed: readonly string[]): string | null {
  return PREFERRED_FAMILIES.find((f) => installed.includes(f)) ?? installed[0] ?? null;
}

/** Longest layer name taken from a text before it is shortened. */
const NAME_LENGTH = 40;

/** A text layer's name: its first non-blank line, trimmed and shortened. */
export function textLayerName(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "Text";
  return line.length > NAME_LENGTH ? `${line.slice(0, NAME_LENGTH - 1)}…` : line;
}

/** Why `size` is not a valid font size, or null when it is. */
export function fontSizeProblem(size: number): string | null {
  return Number.isInteger(size) && size >= TEXT_FONT_SIZE.min && size <= TEXT_FONT_SIZE.max
    ? null
    : `The font size must be a whole number of pixels from ${TEXT_FONT_SIZE.min} to ${TEXT_FONT_SIZE.max}.`;
}

/** `#rrggbb`, the only colour form the colour picker and the Rust rasteriser use. */
export function isHexColor(color: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(color);
}

/** True when there is nothing to draw: an empty or blank text creates or changes nothing. */
export function isBlankText(text: string): boolean {
  return text.trim() === "";
}

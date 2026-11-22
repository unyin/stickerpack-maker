// Pack view modes (SPEC §5): Normal (default; dragging does nothing,
// selection shortcuts active) and Reorder (drag moves one sticker at a time,
// selection shortcuts inactive). Mutually exclusive; the toggle is always
// visible; Esc or the toggle leaves Reorder.

export type Mode = "normal" | "reorder";

export function toggleMode(mode: Mode): Mode {
  return mode === "normal" ? "reorder" : "normal";
}

/** What Esc does: leave Reorder, or clear the selection in Normal. */
export function escapeAction(mode: Mode): "exit-reorder" | "clear-selection" {
  return mode === "reorder" ? "exit-reorder" : "clear-selection";
}

/** Selection clicks and the Delete key work only in Normal mode. */
export function selectionActive(mode: Mode): boolean {
  return mode === "normal";
}

/** A tile's box on screen (DOMRect-like). */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The insertion slot under a pointer: slot i means "before tile i", slot n
 * "after the last". The nearest tile wins (gaps, edges, below the last row);
 * its left half means before it, its right half after it.
 */
export function slotAt(tiles: readonly Box[], x: number, y: number): number {
  if (tiles.length === 0) return 0;
  let best = 0;
  let bestDistance = Infinity;
  tiles.forEach((t, i) => {
    const dx = Math.max(t.left - x, 0, x - (t.left + t.width));
    const dy = Math.max(t.top - y, 0, y - (t.top + t.height));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  const tile = tiles[best];
  return x < tile.left + tile.width / 2 ? best : best + 1;
}

/**
 * The 1-based position a sticker at 0-based `from` moves to when dropped at
 * insertion `slot`, or null when the drop leaves it where it is.
 */
export function dropPosition(from: number, slot: number): number | null {
  if (slot === from || slot === from + 1) return null;
  return (slot > from ? slot - 1 : slot) + 1;
}

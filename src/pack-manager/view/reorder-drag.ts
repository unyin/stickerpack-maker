// Reorder mode's pointer drag (SPEC §5). Pointer events, because HTML5 drag
// and drop is unavailable in the Windows webview while Tauri's file drop is
// enabled. The pack view supplies the grid and what a drop does; the hit
// test and drop position rules live in ../model/modes.
import { dropPosition, slotAt } from "../model/modes";

/** What the drag needs from the pack view. */
export interface ReorderDragHost {
  /** The grid holding the sticker tiles (`.pm-tile[data-id]`). */
  grid: HTMLElement;
  /** False outside Reorder mode or while an action runs. */
  enabled(): boolean;
  /** The sticker's 0-based index in pack order. */
  indexOf(stickerId: number): number;
  /** A sticker was dropped on a new place: move it to 1-based `position`. */
  drop(stickerId: number, from: number, position: number): void;
}

function stickerTiles(grid: HTMLElement): HTMLElement[] {
  return Array.from(grid.querySelectorAll<HTMLElement>(".pm-tile[data-id]"));
}

/** Start dragging a sticker's tile from a pointerdown on it. */
export function startReorderDrag(e: PointerEvent, stickerId: number, host: ReorderDragHost): void {
  if (!host.enabled() || e.button !== 0) return;
  e.preventDefault();
  const { grid } = host;
  const from = host.indexOf(stickerId);
  stickerTiles(grid)[from]?.classList.add("dragging");
  let slot: number | null = null;
  grid.setPointerCapture(e.pointerId);
  const move = (m: PointerEvent) => {
    const current = stickerTiles(grid);
    slot = slotAt(current.map((t) => t.getBoundingClientRect()), m.clientX, m.clientY);
    for (const t of current) t.classList.remove("drop-before", "drop-after");
    if (dropPosition(from, slot) === null) return;
    if (slot < current.length) current[slot].classList.add("drop-before");
    else current[current.length - 1]?.classList.add("drop-after");
  };
  const end = (u: PointerEvent) => {
    grid.removeEventListener("pointermove", move);
    grid.removeEventListener("pointerup", end);
    grid.removeEventListener("pointercancel", end);
    if (grid.hasPointerCapture(u.pointerId)) grid.releasePointerCapture(u.pointerId);
    for (const t of stickerTiles(grid)) t.classList.remove("drop-before", "drop-after", "dragging");
    const position = u.type === "pointerup" && slot !== null ? dropPosition(from, slot) : null;
    if (position !== null) host.drop(stickerId, from, position);
  };
  grid.addEventListener("pointermove", move);
  grid.addEventListener("pointerup", end);
  grid.addEventListener("pointercancel", end);
}

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

/**
 * A faded copy of the sticker's image that follows the cursor while dragging
 * (owner, 2026-11-21), so the sticker feels picked up. Never hit-tested.
 */
function dragGhost(tile: HTMLElement | undefined): { move(x: number, y: number): void; remove(): void } {
  const art = tile?.querySelector<HTMLElement>(".pm-tile-img, .pm-missing-art");
  const ghost = document.createElement("div");
  ghost.className = "pm-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  if (art) ghost.append(art.cloneNode(true));
  document.body.append(ghost);
  return {
    // Centred under the cursor.
    move: (x, y) => (ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`),
    remove: () => ghost.remove(),
  };
}

/** Cleanup of the drag in progress, if any. */
let activeDrag: (() => void) | null = null;

/** Start dragging a sticker's tile from a pointerdown on it. */
export function startReorderDrag(e: PointerEvent, stickerId: number, host: ReorderDragHost): void {
  if (!host.enabled() || e.button !== 0) return;
  e.preventDefault();
  // A stray earlier drag must not leak its listeners. Clean it up BEFORE this
  // drag takes the pointer capture: a mouse reuses the same pointer id.
  activeDrag?.();
  const { grid } = host;
  const from = host.indexOf(stickerId);
  const tile = stickerTiles(grid)[from];
  tile?.classList.add("dragging");
  const ghost = dragGhost(tile);
  ghost.move(e.clientX, e.clientY);
  let slot: number | null = null;
  grid.setPointerCapture(e.pointerId);
  const move = (m: PointerEvent) => {
    ghost.move(m.clientX, m.clientY);
    const current = stickerTiles(grid);
    slot = slotAt(current.map((t) => t.getBoundingClientRect()), m.clientX, m.clientY);
    for (const t of current) t.classList.remove("drop-before", "drop-after");
    if (dropPosition(from, slot) === null) return;
    if (slot < current.length) current[slot].classList.add("drop-before");
    else current[current.length - 1]?.classList.add("drop-after");
  };
  const cleanup = () => {
    grid.removeEventListener("pointermove", move);
    grid.removeEventListener("pointerup", end);
    grid.removeEventListener("pointercancel", end);
    if (grid.hasPointerCapture(e.pointerId)) grid.releasePointerCapture(e.pointerId);
    ghost.remove();
    for (const t of stickerTiles(grid)) t.classList.remove("drop-before", "drop-after", "dragging");
    activeDrag = null;
  };
  const end = (u: PointerEvent) => {
    cleanup();
    const position = u.type === "pointerup" && slot !== null ? dropPosition(from, slot) : null;
    if (position !== null) host.drop(stickerId, from, position);
  };
  grid.addEventListener("pointermove", move);
  grid.addEventListener("pointerup", end);
  grid.addEventListener("pointercancel", end);
  activeDrag = cleanup;
}

/** Abandon a drag in progress (the view was destroyed mid-drag) without dropping. */
export function cancelReorderDrag(): void {
  activeDrag?.();
}

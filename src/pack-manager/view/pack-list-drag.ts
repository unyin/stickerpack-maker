// The Pack list's drag to reorder (SPEC §5, SPM-25): pointer events from the
// row's grip only, like the Pack view's reorder-drag.ts (HTML5 drag and drop
// is unavailable in the Windows webview while Tauri's file drop is enabled),
// and pointer-only like it: no keyboard route. The hit test and drop rules are
// pure and live in ../model (rowSlotAt, dropPosition).
import { dropPosition, rowSlotAt } from "../model/modes";

/** What the drag needs from the Pack list. */
export interface RowDragHost {
  /** The list holding the rows (`.pm-pack-row[data-id]`). */
  list: HTMLElement;
  /** A row was dropped on a new place: reorder its pack to 1-based `position`. */
  drop(packId: number, position: number): void;
}

function packRows(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(":scope > .pm-pack-row[data-id]"));
}

/**
 * A faded copy of the row that follows the cursor, keeping the grab point
 * under it (like the Pack view's sticker ghost). Never hit-tested.
 *
 * The row is a SUBGRID of the list, so a bare clone has no tracks to
 * inherit and collapses into one tall column. The copy therefore sits in a
 * one-row list of its own, fixed to the list's RESOLVED column widths
 * (`getComputedStyle(list).gridTemplateColumns` is the pixel tracks, never
 * the literal `subgrid`), and to the row's width.
 */
export function rowGhost(list: HTMLElement, row: HTMLElement): HTMLElement {
  const ghost = document.createElement("ul");
  ghost.className = "pm-pack-list pm-row-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = `${row.getBoundingClientRect().width}px`;
  ghost.style.gridTemplateColumns = getComputedStyle(list).gridTemplateColumns;
  const copy = row.cloneNode(true) as HTMLElement;
  copy.classList.remove("dragging", "drop-before", "drop-after");
  ghost.append(copy);
  return ghost;
}

/**
 * True from a drag's start until the click that ends it has been delivered. A
 * drag starts on the grip and ends elsewhere in the row, so the browser clicks
 * the row (their common ancestor); the row's click handler asks this to skip
 * that click. An Esc-cancelled drag is still ended by the pointer's release,
 * which clicks too, so the flag outlives the cleanup until that release.
 */
let clickSuppressed = false;

export function rowClickSuppressed(): boolean {
  return clickSuppressed;
}

/** Clear the flag after the release's click (dispatched right after the pointerup). */
function settleClick(): void {
  setTimeout(() => (clickSuppressed = false), 0);
}

/** Cleanup of the drag in progress, if any. */
let activeDrag: (() => void) | null = null;

/** Start dragging a pack's row from a pointerdown on its grip. */
export function startRowDrag(e: PointerEvent, row: HTMLElement, packId: number, host: RowDragHost): void {
  if (e.button !== 0) return;
  e.preventDefault();
  // A stray earlier drag must not leak its listeners. Clean it up BEFORE this
  // drag takes the pointer capture: a mouse reuses the same pointer id.
  activeDrag?.();
  clickSuppressed = true;
  const { list } = host;
  const from = packRows(list).indexOf(row);
  if (from === -1) return;
  const box = row.getBoundingClientRect();
  const grabX = e.clientX - box.left;
  const grabY = e.clientY - box.top;
  const ghost = rowGhost(list, row);
  document.body.append(ghost);
  row.classList.add("dragging");
  document.body.classList.add("pm-row-dragging");
  const place = (x: number, y: number) => (ghost.style.transform = `translate(${x - grabX}px, ${y - grabY}px)`);
  place(e.clientX, e.clientY);
  let slot: number | null = null;
  list.setPointerCapture(e.pointerId);
  const move = (m: PointerEvent) => {
    place(m.clientX, m.clientY);
    const rows = packRows(list);
    slot = rowSlotAt(rows.map((r) => r.getBoundingClientRect()), m.clientY);
    for (const r of rows) r.classList.remove("drop-before", "drop-after");
    if (dropPosition(from, slot) === null) return;
    if (slot < rows.length) rows[slot].classList.add("drop-before");
    else rows[rows.length - 1]?.classList.add("drop-after");
  };
  const cleanup = () => {
    list.removeEventListener("pointermove", move);
    list.removeEventListener("pointerup", end);
    list.removeEventListener("pointercancel", end);
    window.removeEventListener("keydown", escape, true);
    if (list.hasPointerCapture(e.pointerId)) list.releasePointerCapture(e.pointerId);
    ghost.remove();
    // A drag cancelled before the release (Esc, a reload) still ends in a click.
    window.addEventListener("pointerup", settleClick, { once: true, capture: true });
    window.addEventListener("pointercancel", settleClick, { once: true, capture: true });
    document.body.classList.remove("pm-row-dragging");
    for (const r of packRows(list)) r.classList.remove("drop-before", "drop-after", "dragging");
    activeDrag = null;
  };
  const end = (u: PointerEvent) => {
    cleanup();
    settleClick();
    const position = u.type === "pointerup" && slot !== null ? dropPosition(from, slot) : null;
    if (position !== null) host.drop(packId, position);
  };
  // Esc mid-drag cancels: nothing moves, and no other Esc handler sees it.
  const escape = (k: KeyboardEvent) => {
    if (k.key !== "Escape") return;
    k.preventDefault();
    k.stopPropagation();
    cleanup();
  };
  list.addEventListener("pointermove", move);
  list.addEventListener("pointerup", end);
  list.addEventListener("pointercancel", end);
  window.addEventListener("keydown", escape, true);
  activeDrag = cleanup;
}

/** Abandon a drag in progress (the list was left or reloaded mid-drag) without dropping. */
export function cancelRowDrag(): void {
  activeDrag?.();
}

// Normal-mode selection in the pack view (SPEC §5): click selects (replacing
// any selection), Ctrl+click toggles, Shift+click selects a range from the
// anchor, Esc clears. The thumbnail slot is selected on its own: it has no
// position, so it never joins a sticker selection or a range.

export interface SelectionState {
  /** Selected sticker ids, in pack order. */
  readonly ids: readonly number[];
  /** The thumbnail slot is selected (then `ids` is empty). */
  readonly thumbnail: boolean;
  /** Where the next Shift+click range starts: the last plain or Ctrl click. */
  readonly anchor: number | null;
}

export interface ClickModifiers {
  readonly ctrl: boolean;
  readonly shift: boolean;
}

export const NO_SELECTION: SelectionState = { ids: [], thumbnail: false, anchor: null };

/** Which panel the selection shows (SPEC §5). */
export type Panel = "none" | "detail" | "aggregate" | "thumbnail";

/** Modifiers from a mouse event; Cmd counts as Ctrl for a later macOS build. */
export function modifiersOf(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): ClickModifiers {
  return { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
}

function inOrder(ids: Iterable<number>, order: readonly number[]): number[] {
  const chosen = new Set(ids);
  return order.filter((id) => chosen.has(id));
}

/** Apply a click on sticker `id`; `order` is the pack's sticker ids in position order. */
export function clickSticker(
  state: SelectionState,
  order: readonly number[],
  id: number,
  mods: ClickModifiers,
): SelectionState {
  const at = order.indexOf(id);
  if (at < 0) return state;
  const anchorAt = state.anchor === null ? -1 : order.indexOf(state.anchor);
  if (mods.shift && anchorAt >= 0) {
    const [lo, hi] = anchorAt < at ? [anchorAt, at] : [at, anchorAt];
    return { ids: order.slice(lo, hi + 1), thumbnail: false, anchor: state.anchor };
  }
  if (mods.ctrl) {
    const ids = state.ids.includes(id) ? state.ids.filter((x) => x !== id) : [...state.ids, id];
    return { ids: inOrder(ids, order), thumbnail: false, anchor: id };
  }
  return { ids: [id], thumbnail: false, anchor: id };
}

/** Select the thumbnail slot alone, whatever the modifiers. */
export function clickThumbnail(): SelectionState {
  return { ids: [], thumbnail: true, anchor: null };
}

/** Keep only stickers still in the pack (after a reload, delete, or reorder). */
export function pruneSelection(state: SelectionState, order: readonly number[], hasThumbnailSlot = true): SelectionState {
  const ids = inOrder(state.ids, order);
  const anchor = state.anchor !== null && order.includes(state.anchor) ? state.anchor : null;
  return { ids, thumbnail: state.thumbnail && hasThumbnailSlot, anchor };
}

export function panelFor(state: SelectionState): Panel {
  if (state.thumbnail) return "thumbnail";
  if (state.ids.length === 1) return "detail";
  return state.ids.length > 1 ? "aggregate" : "none";
}

// The scroll-into-view mechanics shared by the two right-panel lists
// (SPM-15): the Actions list tracks its present row, and the Layers list
// reveals the selected one. One rule serves every add and selection: scroll
// only when the row is not fully visible, so a render with the row already in
// view never nudges the list.

/**
 * Scroll `scroller` just enough that `row` is fully inside `view`.
 *
 * A sub-pixel overhang is a rounding artefact, not a hidden row: it is left
 * alone. The deltas are floored/ceiled so the row lands within a whole pixel.
 * The same signs serve a `column-reverse` scroller too: decreasing scrollTop
 * moves the content down in either flow, so "above" still means subtract.
 */
export function revealRow(scroller: HTMLElement, row: HTMLElement, view: HTMLElement = scroller): void {
  const r = row.getBoundingClientRect();
  const v = view.getBoundingClientRect();
  const above = v.top - r.top;
  const below = r.bottom - v.bottom;
  if (above > 0.5) scroller.scrollTop = Math.floor(scroller.scrollTop - above);
  else if (below > 0.5) scroller.scrollTop = Math.ceil(scroller.scrollTop + below);
}

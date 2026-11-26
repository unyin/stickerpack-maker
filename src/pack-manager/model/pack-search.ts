// The Pack list's search (SPEC §5, SPM-25): which packs the box shows, and
// whether reordering is allowed meanwhile. Pure, so testable without a webview.
import { normaliseQuery } from "../../shared/match-names";

/** The Pack list's search text, trimmed; "" means no filter. */
export function packQuery(raw: string): string {
  return raw.trim();
}

/**
 * The packs the Pack list search shows, in their stored order: those whose
 * Title or Short Name contains the trimmed query, case-insensitively. An empty
 * (or blank) query shows them all. Unlike matchPacks (the pickers), never reorders.
 */
export function filterPacks<P extends { title: string; shortName: string }>(packs: readonly P[], raw: string): P[] {
  const q = normaliseQuery(raw);
  if (q === "") return [...packs];
  return packs.filter((p) => p.title.toLowerCase().includes(q) || p.shortName.toLowerCase().includes(q));
}

/** Reordering is off while the search box has text: a filtered list hides rows, so a drop position would be ambiguous. */
export function reorderAllowed(raw: string): boolean {
  return packQuery(raw) === "";
}

/** What the Pack list shows for a search: which packs, and the list's state. */
export interface SearchView {
  /** Ids of the packs that match, in stored order. */
  shownIds: Set<number>;
  /** True while the search has text: grips are hidden and no drag starts. */
  filtering: boolean;
  /** True when the Library has packs but none match. */
  noMatch: boolean;
}

export function searchView(packs: readonly { id: number; title: string; shortName: string }[], raw: string): SearchView {
  const shown = filterPacks(packs, raw);
  return { shownIds: new Set(shown.map((p) => p.id)), filtering: !reorderAllowed(raw), noMatch: packs.length > 0 && shown.length === 0 };
}

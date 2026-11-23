// Type-to-search for the app's comboboxes (src/combobox.ts): pure, so it is
// testable without a webview.

/**
 * Names matching `query`, case-insensitive: those starting with it first,
 * then those containing it, each group in list order; an empty query keeps
 * every item. `alsoContains` adds text that may contain the query too.
 */
export function matchNames<T>(
  items: readonly T[],
  query: string,
  name: (item: T) => string,
  alsoContains: (item: T) => string = () => "",
): readonly T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return items;
  const starts: T[] = [];
  const contains: T[] = [];
  for (const item of items) {
    const n = name(item).toLowerCase();
    if (n.startsWith(q)) starts.push(item);
    else if (n.includes(q) || alsoContains(item).toLowerCase().includes(q)) contains.push(item);
  }
  return [...starts, ...contains];
}

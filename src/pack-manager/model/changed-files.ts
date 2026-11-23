// Sticker files the Editor replaced (SPM-10, owner decision 2026-11-22): a
// replace keeps the sticker's id, so an open pack view's preview, cached by
// id, would keep showing the old picture. The Editor marks the sticker; the
// pack view forgets those previews when it re-reads itself.

const changed = new Set<number>();

/** The file of sticker `id` was replaced. */
export function markStickerFileChanged(id: number): void {
  changed.add(id);
}

/** The stickers replaced since the last call, forgotten as they are returned. */
export function takeChangedStickers(): number[] {
  const ids = [...changed];
  changed.clear();
  return ids;
}

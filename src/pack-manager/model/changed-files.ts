// Sticker and thumbnail files the Editor replaced (SPM-10/12, owner
// decision 2026-11-22): a replace keeps the sticker's id, so an open pack
// view's preview, cached by id, would keep showing the old picture; a
// thumbnail save rewrites the pack's one unnumbered file the same way. The
// Editor marks the file; the pack view forgets those previews when it
// re-reads itself.

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

const changedThumbnails = new Set<number>();

/** The thumbnail file of pack `packId` was replaced or deleted. */
export function markThumbnailChanged(packId: number): void {
  changedThumbnails.add(packId);
}

/** The packs whose thumbnails changed since the last call, forgotten as they are returned. */
export function takeChangedThumbnails(): number[] {
  const ids = [...changedThumbnails];
  changedThumbnails.clear();
  return ids;
}

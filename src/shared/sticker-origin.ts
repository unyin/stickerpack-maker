// The sticker an Editor session edits, when the Pack Manager's Edit opened it
// (owner decision 2026-11-22): saving then offers to replace it. Shared by the
// Pack Manager (which opens the session) and the Editor (which saves it).

export interface StickerOrigin {
  readonly stickerId: number;
  readonly packId: number;
  /** Where it sat and its pack's title when the session took it, for the "no longer exists" message. */
  readonly position: number;
  readonly packTitle: string;
  /** Set when the Library changed since: its id belongs to the old Library, so it cannot be replaced. */
  readonly otherLibrary?: boolean;
}

/** The origin for a sticker of the pack titled `packTitle`. */
export function stickerOrigin(sticker: { id: number; packId: number; position: number }, packTitle: string): StickerOrigin {
  return { stickerId: sticker.id, packId: sticker.packId, position: sticker.position, packTitle };
}

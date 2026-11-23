// The pack whose thumbnail an Editor session edits (SPEC §5-7): the Pack
// Manager's thumbnail slot (SPM-12) opens the session — Create from a new
// image or a copy of any pack sticker, Replace likewise — and the Editor's
// Thumbnail mode saves into it, replacing the pack's unnumbered thumbnail
// file under the save hard-block (exactly the thumbnail side square,
// within its cap, PNG/WEBP, SPEC §6-7). Shared by the two ends like the
// sticker origin is: the Pack Manager (which opens the session) and the
// Editor (which saves into it).

export interface ThumbnailOrigin {
  readonly packId: number;
  /** The pack's title when the session took it, for messages if the pack is gone. */
  readonly packTitle: string;
  /** Set when the Library changed since: its id belongs to the old Library, so it cannot be saved into. */
  readonly otherLibrary?: boolean;
}

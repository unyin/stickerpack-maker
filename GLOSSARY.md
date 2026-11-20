# Stickerpack Maker

A local desktop tool for creating Telegram-ready sticker images and organizing them into packs.

## Language

**Pack**:
An ordered collection of stickers with a title, a short name, and an optional thumbnail, mirroring one Telegram sticker set.
_Avoid_: set, stickerpack, album

**Title**:
A pack's human-readable name, 1–64 characters.
_Avoid_: full name, display name

**Short Name**:
A pack's identifier as it appears in its Telegram URL; letters, digits, and underscores only, up to 64 characters.
_Avoid_: internal name, truncated name, slug

**Draft**:
The state of a pack that has not yet been created on Telegram; the default state of a new pack.
_Avoid_: unpublished, local-only

**Live**:
The state of a pack that exists on Telegram.
_Avoid_: published, uploaded, synced

**Sticker**:
One finished, flattened image belonging to exactly one pack, with its own emoji string; PNG or WEBP, one side exactly 512 px and the other at most 512 px.
_Avoid_: tile, picture (when meaning a pack member)

**Emoji String**:
The 1–20 emoji assigned to a sticker, which Telegram uses for search and suggestions.
_Avoid_: emoji set, tags

**Thumbnail**:
A pack's separate representative image, exactly 100×100 px; not a sticker, with no position in the pack and no emoji.
_Avoid_: cover, cover image

**Duplicate**:
An independent copy of a sticker — image file and emoji string — placed in another pack, editable separately from the original.
_Avoid_: reference, link

**Move**:
A duplicate to another pack followed by deletion of the original.
_Avoid_: transfer

**Send to pack**:
The operation of copying one or more stickers to another pack, optionally deleting the originals afterwards; without deletion it is a Duplicate, with deletion a Move.
_Avoid_: export (when meaning this operation)

**Missing**:
The state of a sticker whose image file cannot be found in the library; it must be replaced before it can be edited, duplicated, or moved.
_Avoid_: broken, orphaned

**Library**:
The app-managed store of all packs and their image files.
_Avoid_: database (when meaning the whole store)

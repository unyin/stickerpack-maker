# Triage: §8 future seams

Type: grilling
Status: resolved

## Question

Verdict (v2 / v3 / rejected) for each SPEC §8 future seam: Bot API sync; custom emoji packs (100×100); animated .TGS and video .WEBM stickers; DB reconstruction from orphaned files; project files / version history (and the export/prep folders and scratch saves listed with it).

## Answer

Owner verdicts (2026-11-27). Costs are rough, in focused agent sessions.

**v2**: none.

**v3**

- **Bot API sync** (~4-6), with the owner's note that it may slip further, to v4. Telegram rules found while costing it: a bot can manage only packs it created, so packs made through @Stickers (every Live pack today) can never sync; a bot-created pack's Short Name must end in `_by_<botname>`, which changes the Short Name rules and the Draft-to-Live step. It also needs bot-token storage, Rust HTTP calls, a schema change recording each sticker's Telegram file id and sync state, a local-versus-remote diff, and error/rate-limit handling.
- **Manual sync to-do list for Live packs** (new, the owner's idea; the more viable v3 goal than Bot API sync): changes made to a Live pack (e.g. moving stickers) add the operations to perform in @Stickers to a to-do list, shown when the owner presses a button to sync the pack manually. Its scope (which changes are tracked, how items are ticked off) is decided when it is planned.
- **Custom emoji packs (100x100)** (~2-3): a pack type on Pack (a new domain distinction), a schema migration, per-type size rules and validation, an Editor target size (Thumbnail mode already produces 100x100), per-type Upload list wording.
- **Video .WEBM stickers** (~3-4): import a video or GIF, trim, scale and encode (VP9, at most 3 s, 512 px, 256 KB, no audio) with a bundled ffmpeg (+~80 MB installer); no frame editing.
- **Editor project files / scratch saves** (~2): save an unfinished Editor session (layers, text, effects) and resume it later; reverses SPEC §6's deliberate "no scratch/draft save location".

**v4**

- **Sticker version history** (~2-3, plus storage growth): keep earlier versions of a sticker's image to restore. The owner is considering rejecting it, and parks it further down the line for now.

**Rejected**

- **Animated .TGS stickers** (owner, 2026-11-27): Lottie vector animation needs a vector animation editor, a different app from this raster editor.
- **DB reconstruction from orphaned files** (owner, 2026-11-27): back up the Library folder, which holds the database; a rebuild would recover only packs (folder = Short Name) and order (ADR-0003 filenames), not titles, emoji, status or the thumbnail, too little to be worth it.
- **Export/prep folders** (owner, 2026-11-27): ADR-0003's order-encoded filenames already put Library files in pack order for dragging into @Stickers, so no export step is needed.

# Pack order is encoded in library filenames

The owner uploads packs to Telegram manually via @Stickers, dragging files straight from the file explorer, and wants them already in pack order with no export step. We therefore made the library app-managed and position-named: sticker files are `001.png`, `002.webp`, … (three digits, covering Telegram's 120-sticker cap), and every reorder, insert, duplicate, or move renames files on disk to match. The thumbnail is unnumbered (`thumbnail.*`) so it never sorts into the sequence. The rejected alternative — stable filenames with order only in the database — would have required the export/prep folder the owner explicitly declined.

## Consequences

- Renaming must be crash-safe (two-phase renames to avoid collisions); the database and filenames must never disagree after an operation.
- Renaming files outside the app desyncs the library. The app detects absent files, marks the sticker **Missing**, and offers replacement through the validated drop-in path; a Missing sticker cannot be edited, duplicated, or moved until replaced.
- "Open in explorer" selects the sticker's file, so the owner can drag files into @Stickers in filename order.

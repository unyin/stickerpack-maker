# Triage: Pack Manager interactions

Type: grilling
Status: resolved

## Question

Verdict (v2 / v3 / rejected) for each Pack Manager item in the v2 lot: double-click shortcuts (e.g. double-click a sticker to open the Editor); right-click context menu mirroring the detail panel's commands; click-and-hold a sticker to activate Reorder mode; group-drag reorder; trash/recovery area for deleted stickers; emoji picker button next to the Emoji String field.

## Answer

Owner verdicts, 2026-11-27 (rough costs in focused agent sessions):

- **Double-click shortcuts: v2** (~0.5). Double-clicking a sticker tile goes straight to Edit, skipping the Edit / Replace… / Cancel ask (the unsaved-changes dialog still applies). Thumbnail and Pack list double-click settled at implementation.
- **Right-click context menu: v2** (~1), built with double-click. Mirrors the detail panel's commands (single selection) or the aggregate panel's (multiple); right-clicking outside the selection selects that tile first. **The menu is a reusable app-wide component**, not Pack-Manager-specific: the owner wants an Editor right-click menu later (owner note).
- **Click-and-hold for Reorder: v2**, merged with group-drag below. The owner finds the Reorder toggle breaks the flow of arranging a pack; since hold is the gesture that starts a group drag, building group-drag without it would mean redesigning the gesture twice.
- **Group-drag reorder: v2** (~1-1.5 with hold-to-reorder; the Rust core already rewrites the whole order in one go). Design:
  - Hold a tile **~500ms** (default) to start a reorder drag, with fill-up feedback on the tile while holding. **The hold duration is adjustable in Settings** (owner); range and step are settled at implementation.
  - Holding a **selected** tile drags the whole selection as one block, in pack order; holding an **unselected** tile replaces the selection with it and drags it alone; moving more than a few pixels before the hold completes cancels the hold.
  - While dragging: the Reorder green tint and the faded drag copy (with a count for a group). Dropping ends Reorder immediately; the moved stickers stay selected in their new place; Esc mid-drag cancels with nothing moved.
  - **The Reorder toggle stays** for runs of moves; in toggle mode, dragging a selected tile also moves the whole selection, so the two entry points behave alike (toggle mode just stays on between drops).
- **Trash/recovery: v3** (~2-3 plus design). The owner's direction for later: a "staging area" / "unassigned stickers" place first, where recovered stickers that don't go back to their original pack could land. The v3 lot entry should carry this idea.
- **Emoji picker button: v2** (~1-2). The value: the Windows Win+. panel uses Segoe glyphs and lacks newer emoji (e.g. 🫵); an in-app picker shows the app's chosen emoji font. Needs bundled, offline emoji data (groups, names for search) and a popover. Build or adopt an MIT component (with its data bundled, not fetched from a CDN) is decided when the task is written.

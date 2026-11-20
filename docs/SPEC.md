# Stickerpack Maker — v1 Specification

Status: agreed in a grilling session on 2026-11-18. This document is the source of truth for v1 scope.
Vocabulary: see `GLOSSARY.md`. Durable decisions: see `docs/adr/` (0001 stack, 0002 independent copies, 0003 order-encoded filenames, 0004 crash-safe rename mechanics).

## 1. Overview

A local-first desktop app for making Telegram sticker packs, with two tools:

- **Editor** — image editing to produce finished stickers and thumbnails.
- **Pack Manager** — database and file operations organizing stickers into packs.

No Telegram network calls in v1. The data model mirrors Telegram's rules so Bot API sync
(`createNewStickerSet`, `addStickerToSet`, `replaceStickerInSet`, `setStickerPositionInSet`,
`setStickerEmojiList`, `setStickerSetTitle`, `setStickerSetThumbnail`) is a clean later addition.
Uploads in v1 are manual via @Stickers, dragging files from the explorer in filename order.

## 2. Platform and stack

- Windows v1; macOS later, Linux maybe. (ADR-0001)
- **Tauri**: Rust core (files, library, SQLite) + web-frontend canvas editor.
- Background removal runs offline via ONNX with a one-time model download. Whether ONNX runs
  in Rust (`ort`) or the webview (onnxruntime-web) is a deferred engineering decision (own ADR).
- Difficult implementation choices get ADRs and detailed task breakdowns.

## 3. Domain model

### Pack
- **Title**: free text, 1–64 characters; always editable.
- **Short Name**: Telegram slug — letters/digits/underscores, must begin with a letter, no
  consecutive underscores, ≤64 characters. Auto-derived from the title, manually editable
  **only while Draft; locked once Live** (Telegram short names are immutable after creation).
  The `_by_<bot_username>` suffix applies only to bot-created sets (future sync, not v1).
  Short Names are **unique within the Library** (case-insensitive) because each pack's folder
  is named after its Short Name; an auto-derived name that is taken gets a numeric suffix
  (`cats_2`), a typed one is refused. Windows reserved names (`con`, `prn`, `aux`, `nul`,
  `com0`–`com9`, `lpt0`–`lpt9`) are refused.
- **Status**: **Draft** (default for new packs; not yet on Telegram) or **Live** (exists on
  Telegram). v1: manual toggle both ways; Live→Draft shows a warning. Live status otherwise
  changes nothing in v1 beyond the badge and the short-name lock.
- **Thumbnail**: optional; see §6.
- Deleting a **Draft** pack deletes its folder and files after confirmation. Deleting a
  **Live** pack deletes locally only, warning that the Telegram pack remains and must be
  removed via @Stickers.
- Warn (do not block) when a pack exceeds **120 stickers** (Telegram's cap).

### Sticker
- One finished, flattened PNG or WEBP image belonging to **exactly one pack**, with its own
  **Emoji String** and position. (ADR-0002)
- Static packs may mix PNG and WEBP; there is no pack-level format.
- **Emoji String**: 1–20 emoji. Validation warns, never blocks (drafts may be incomplete).
  One-click copy of the exact string to clipboard.
- **Duplicate**: independent copy of image file + emoji string into another pack, appended at
  its end; editable separately afterwards.
- **Move**: duplicate + delete original, offered as one action.
- **Missing**: file absent from the library (desync). Highlighted in the Pack Manager;
  cannot be edited, duplicated, or moved until replaced via the validated drop-in path (§5).

### Library
- App-managed folder chosen at first run (suggested default `Documents\Stickerpack Library`),
  containing the SQLite DB and one folder per pack, named after the pack's Short Name (a Draft
  Short Name edit renames the folder). Path shown in settings.
- **Manual re-pointing in v1**: settings can point the app at another library folder (moved or
  restored library). Re-pointing expects an intact library (DB included).
- A **fresh** library + DB can always be created from scratch (first run, or re-point at an
  empty folder). **Reconstructing** metadata (titles, short names, emoji, status, thumbnails)
  from orphaned image files is out of scope for v1.
- No auto-migration in v1.

## 4. Files and order (ADR-0003)

- Sticker files are named by position: `001.png`, `002.webp`, … — three-digit zero-padding,
  extension = actual format. Thumbnail is unnumbered (`thumbnail.png` / `thumbnail.webp`).
- Reorder, insert, duplicate, move, and delete **rename files on disk** so filenames always
  match pack order. Renames must be crash-safe (two-phase to avoid collisions); DB and
  filenames must never disagree after an operation.
- The library is app-managed: renaming files outside the app desyncs it.
- **Desync checks run only when a pack is opened, plus a manual refresh. Never on app start.**
  Absent files mark the sticker **Missing**.
- "Open in explorer" opens the pack folder **with the sticker's file selected**.

## 5. Pack Manager

Command map agreed with the owner on 2026-11-19 (SPM-4). One selection→panel paradigm for
stickers, Missing stickers, and the thumbnail.

### Pack view modes
- **Normal (default)**: dragging does nothing. Selection: click = select that sticker
  (replaces any selection); Ctrl+click = toggle in/out; Shift+click = range; Esc = clear
  selection. One selected → detail panel; several → aggregate panel.
- **Reorder** (toggle button in the pack toolbar): drag to reorder, one sticker at a time;
  selection shortcuts inactive; Esc or the toggle exits. Reorder renames files on disk (§4).
- The two modes are mutually exclusive; the toggle is always visible.

### Detail panel (single selection)
- Large preview; metadata: position, format, dimensions, file size.
- **Emoji String**: inline editable field (type, or Win+. for the Windows emoji panel),
  adjacent one-click **copy** button, live 1–20 count warning.
- Actions: **Edit** (opens the flattened image in the Editor); **Replace** (preserves
  position + emoji; validated drop-in or via Editor, §5 replacement rules below);
  **Send to pack…**; **Open in explorer** (folder opens with the file selected);
  **Delete** (confirmation dialog showing preview + emoji, then permanent; Delete key
  shortcut). No double-click behavior in v1.

### Aggregate panel (multiple selection)
- "N stickers selected" + combined file size. Exactly two actions: **Send to pack…** and
  **Delete** (bulk confirmation showing the affected stickers). Per-sticker actions require
  single selection.

### Send to pack (single and bulk; the unified Duplicate/Move command)
- Dialog: searchable target-pack list with Draft/Live badges, current pack excluded, inline
  **New pack…** (Title → auto Short Name, Draft).
- Checkbox **"Delete originals after sending"**, default off. Off = Duplicate; on = Move.
- Stickers append at the target's end in source-pack order, each with its emoji string
  copied — independent copies (ADR-0002).
- **Two-phase transaction, enforced in the library core**: (1) copy and verify every
  selected sticker; (2) only if ALL copies succeeded and the checkbox is on, delete the
  originals and **renumber the source pack to fill the gaps** (files renamed; no erroneous
  Missing states afterwards).
- Failure rules: any copy failure → roll back partial copies, originals untouched, per-file
  error report. Delete-phase failure → explicit report of the final state (what was copied,
  what remains); never silent loss. Target reaching the 120-sticker cap → warning.

### Replacement rules
- *Drop-in*: file must already be a valid sticker (PNG/WEBP, one side exactly 512 px,
  ≤512 KB). Non-conforming files are **hard-blocked** with "open in editor / cancel".
- *Editor*: edit the existing flattened image, or edit a new image, then save into the slot.

### Missing stickers
- Warning badge on the tile; panel banner with **Replace file** (the validated drop-in path)
  and **Delete** (removes the slot and renumbers the pack to fill the gap). Edit and Send
  are disabled with the reason shown.

### Thumbnail slot
- Same panel paradigm minus emoji and position: Create (new image or a copy of any pack
  sticker, via Editor thumbnail mode), Replace, Delete, Open in explorer. Visually distinct
  slot at the end of the list; unnumbered file (§4).

### Pack-level
- Create pack (Title → auto Short Name, editable while Draft; new packs are Draft).
- Pack header: Title always editable; Short Name editable only in Draft; Draft/Live manual
  toggle both ways (Live→Draft warned).
- **Bulk import**: drag-drop multiple images onto a pack. Same validity rule as drop-in —
  valid files added as-is in drop order; invalid files rejected per-file with an
  "open in editor" option. Imported stickers get no emoji; empty-emoji stickers are flagged.
- Desync checks on pack open + manual refresh only, never on app start (§4).
- 120-sticker warning; pack deletion semantics per §3.

## 6. Editor

### Import and canvas
- Source formats: .jpg, .jpeg, .jfif, .png, .webp.
- Canvas sizes itself to the imported image. Imports larger than **2000×2000** trigger a
  dialog: **OK** scales to fit within 2000×2000 preserving aspect ratio (longest side 2000);
  **Cancel** aborts the import.
- The image is draggable on the canvas (pan/zoom for editing comfort).

### Crop and sizing
- Togglable **512×512 box overlay**, fixed at canvas center; never draggable/resizable.
  Drag the image to choose what survives.
- **Crop** is destructive: everything outside the box is discarded; canvas becomes 512×512.
- Sizing tools (whole image, aspect preserved, transparency padding where relevant):
  1. Fit to 512×512 and pad the rest with transparency.
  2. Scale longest side to 512 px.
  3. Free resize: entered value = longest side.
- Live readout of current dimensions vs the active constraint set.

### Layers and tools
- Session layer model: base image, pasted cutouts, text objects. Undo/redo throughout.
- **Cut / paste / resize** floating parts.
- **Enlarge selected parts**: local warp/bulge (strength + radius), paints on the selected layer.
- **Background removal**: one-click offline ONNX auto removal + manual refine brush.
- **Outline** and **fuzzy glow**: target the selected layer, or the base image when nothing
  is selected.
- **Text**: own layer, movable/resizable until save (system fonts, size, color).
- **Merge selected layers**: flatten chosen layers together mid-session so effects can be
  applied to the merged result before the final save flatten.

### Save (hard-blocked)
- No project files: saved output is flattened and final. Re-editing opens the flattened image.
- Save dialog: pick target pack (create-new inline); choose **PNG or WEBP** per save.
- **Saving is blocked unless constraints are met** — no warn-and-proceed path:
  - Sticker mode: longest side exactly **512 px** and file ≤ **512 KB**.
  - Thumbnail mode: exactly **100×100 px** and file ≤ **128 KB**, PNG/WEBP.
- The live readout shows by how much the image is off; sizing tools fix it in one click.
- Closing the editor with unsaved changes warns first. Unfinished, non-conforming work
  cannot be parked — there is deliberately no scratch/draft save location.
- Thumbnail mode is the same editor with a 100×100 canvas and the thumbnail constraint set.

## 7. Constraints quick reference

| Thing | Rule | Enforcement |
|---|---|---|
| Sticker dimensions | one side exactly 512 px, other ≤512 px | hard block on save, drop-in, bulk import |
| Sticker file | PNG or WEBP, ≤512 KB | hard block on save, drop-in, bulk import |
| Thumbnail | exactly 100×100 px, PNG/WEBP, ≤128 KB | hard block on save |
| Editor import | ≤2000×2000 | dialog: scale-to-fit or abort |
| Emoji string | 1–20 emoji | warn only |
| Pack size | ≤120 stickers | warn only |
| Title | 1–64 chars | validate |
| Short name | a-z A-Z 0-9 _, starts with letter, no `__`, ≤64; unique in Library; not a Windows reserved name | validate; locked when Live |

## 8. Out of scope for v1 (future seams)

- Bot API sync (model is shaped for it; Draft/Live and short-name lock anticipate it).
- Custom emoji packs (100×100), animated .TGS, video .WEBM.
- Library auto-migration; DB reconstruction from orphaned files.
- Project files / version history; export/prep folders; scratch saves.

## 9. Deferred decisions

- **UX**: decided — see the §5 command map (SPM-4, 2026-11-19).
- **Engineering (each gets an ADR at implementation time)**: ONNX runtime placement
  (Rust vs webview); canvas library choice; crash-safe rename mechanics — decided,
  see ADR-0004 (SPM-2).
- Small UX defaults assumed unless preferences emerge: system fonts + size/color for text;
  color/width for outline; color/radius/softness for glow; strength/radius for warp.

### v2 parking lot (UX)
- Double-click shortcuts (e.g. double-click a sticker to open the Editor).
- Right-click context menu mirroring the detail panel's commands.
- Click-and-hold a sticker to activate Reorder mode.
- Group-drag reorder (moving several stickers at once).
- Trash/recovery area for deleted stickers.
- Bulk emoji-set: rejected as unnecessary — not planned.

## 10. Draft work packages (for review — not yet filed as issues)

1. **Scaffold**: Tauri app skeleton (Rust + TS), Windows build, SQLite, first-run library
   chooser, settings (path display, manual re-point, fresh-library creation).
2. **Library core (Rust)**: schema (packs/stickers/thumbnail/emoji/status), order-encoded
   filenames, crash-safe renames, desync detection (pack-open + manual refresh), Missing state.
3. **Pack Manager UI**: pack list/create, Draft/Live toggle + short-name lock, pack view
   (Normal/Reorder modes, detail + aggregate panels, thumbnail slot), emoji edit/copy,
   explorer reveal, delete semantics, 120 warning, bulk import with validation.
4. **Per-sticker command UX design pass** — completed 2026-11-19; command map in §5.
5. **Editor foundation**: import pipeline + 2000 cap dialog, canvas fit, layers, undo/redo,
   drag/pan/zoom, merge selected layers, flatten-on-save plumbing.
6. **Crop & sizing**: 512 box overlay, destructive crop, three sizing tools, live readout.
7. **Background removal**: ONNX placement ADR, offline auto removal, refine brush.
8. **Effects**: outline, fuzzy glow, warp/bulge (layer-targeted).
9. **Cut/paste/resize + text tool**.
10. **Save pipeline**: target-pack picker, PNG/WEBP encoding, hard-block validation (both
    modes), unsaved-changes close warning.
11. **Replace and Send-to-pack flows**: validated drop-in, slot-preserving replace,
    unified Send to pack (single/bulk, two-phase atomicity, source renumbering), Missing
    replacement and Missing-slot deletion.
12. **Thumbnail mode**: 100×100 editor mode + thumbnail CRUD in pack view.

Dependency spine (wired in Trekker): 1 → 2 → 3; 5 → 6/7/8/9 → 10; 2+10 → 11; 5+10 → 12;
4 gated the final shape of 3's per-sticker surface (resolved).

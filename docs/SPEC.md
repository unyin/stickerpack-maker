# Stickerpack Maker — v1 Specification

Status: agreed in a grilling session on 2026-11-18. This document is the source of truth for v1 scope.
Vocabulary: see `GLOSSARY.md`. Durable decisions: see `docs/adr/` (0001 stack, 0002 independent copies, 0003 order-encoded filenames, 0004 crash-safe rename mechanics, 0005 editor hybrid split).

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
  `com0`–`com9`, `lpt0`–`lpt9`) are refused; an auto-derived name that would be reserved
  gets a `_pack` suffix (e.g. `con_pack`).
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
- The canvas starts square at the active constraint set's side: **512×512** for stickers,
  **100×100** for thumbnails (owner decision 2026-11-20); it is never set from the imported
  image. The opened image is placed at its native pixel size, centred on the canvas, and may
  overflow it.
- Imports larger than **2000×2000** (the import cap) trigger a dialog: **OK** scales to fit
  within 2000×2000 preserving aspect ratio (longest side 2000); **Cancel** aborts the import.
- The image is draggable on the canvas (pan/zoom for editing comfort).
- One session at a time (owner decision 2026-11-20): with no session open, **Open image**
  starts one; while a session is open, another image can only be brought in with **Add image
  as layer** (native pixel size, centred on the canvas, on top; may overflow; same 2000×2000
  rule). Starting over means **Close** first, which warns when there are unsaved changes.

### Crop and sizing
- Togglable **box overlay** at the active constraint set's side (owner decision 2026-11-20):
  a 512×512 box for stickers, 100×100 for thumbnails. Fixed at canvas center; never
  draggable/resizable; drawn **above all layers** so it stays visible when layers cover the
  canvas.
  Drag the image to choose what survives. The overlay is **on by default** and the **Crop
  box** button shows or hides it (owner decision 2026-11-20). The box is the set's side,
  **capped at the canvas size on each axis**, so it is never larger than the canvas: a
  512×439 canvas gets a 512×439 box (owner decision 2026-11-20). It follows the canvas size,
  staying centred; when the canvas and box sides differ by an odd number, its top-left is
  rounded down to a whole pixel, so it always covers whole pixels. The Crop button names
  the actual box size (e.g. **Crop to 512×439**) (agent decision, pending owner confirmation).
- **Crop** is destructive: everything outside the box (512×512 for stickers, 100×100 for
  thumbnails, capped at the canvas size as above) is discarded; the canvas size stays as it
  is (owner decision 2026-11-20).
  - A layer inside the box is left exactly as it is. A layer crossing the box edge keeps
    only the whole pixels it covers inside the box: it becomes an unrotated, unscaled layer
    at that spot, with its rotation and scale baked into its pixels. It keeps its name and
    its place in the stack (agent decision, pending owner confirmation).
  - Layers **entirely outside** the box are discarded in the same single undo step (owner
    decision 2026-11-20). If every layer is entirely outside, Crop is disabled ("Nothing is
    inside the box"), because a session always keeps at least one layer.
  - Crop is disabled, with the reason in its tooltip, when nothing lies outside the box (agent decision, pending owner confirmation).
  - Crop never moves the view: the canvas origin does not move.
  - Text layers on Crop (agent decision SPM-9, pending owner confirmation): a text layer
    is measured by its rendered box, turned and scaled with the layer, like an image by its
    pixels, so every rule above applies to it unchanged. Inside the box it stays
    editable text; entirely outside it is discarded like an image; crossing the box edge it
    is rasterised (in Rust) and clipped like an image, becoming an image layer with the same
    name and place: text cannot both stay editable and lose its outside part. The "at least
    one layer" rule is unchanged.
- Sizing tools (whole image, aspect preserved, transparency padding where relevant). "Whole
  image" = everything on the canvas treated as one layer, exactly like selecting every layer
  and resizing them together (owner decision 2026-11-20). Sides below are Sticker mode's;
  Thumbnail mode uses 100 for tools 1 and 2 (see Save):
  1. **Fit to 512×512**: scale the whole image so its longest side is 512, set the canvas to
     512×512 and centre the image; the user can then reposition it, and the rest is
     transparent padding.
  2. **Longest side 512**: scale the whole image so its longest side is 512, then set
     the canvas to the scaled image's size in whole pixels (no padding).
  3. **Free resize**: scale the whole image so its longest side is the entered value, a whole
     number of pixels from 1 to 2000. The canvas size does not change; the image keeps its
     centre where it was.
- Only sizing tools 1 and 2 change the canvas size (owner decision 2026-11-20). Nothing else
  does: not opening an image (the canvas starts at the constraint set's side), adding a
  layer, merging, deleting, Crop, free resize, or undo/redo of any of these.
- The sizing tools change the canvas or the image, **never the view**: zoom and pan stay where
  the user left them (owner decision 2026-11-20). The canvas keeps its top-left corner where
  it was on screen, so the outline grows or shrinks by the same factor as the canvas.
  Undo/redo of a sizing tool behaves the same.
- **Reset view** is the only way to re-fit: it re-centres the canvas and zooms to fit it in
  the view (never above 100%), without changing the image. The view is fitted automatically
  only when an editing session opens.
- **Live readout** of the canvas size against the active constraint set (owner decision
  2026-11-20): Sticker mode means longest side 512; Thumbnail mode means exactly 100×100.
  It shows the canvas size and either that it meets the set or how many pixels each side is
  over or under (e.g. "600×400 px · needs longest side 512: 88 px over"), and updates on
  every change, undo and redo included (agent decision, pending owner confirmation).

### Layers and tools
- Session layer model: base image, pasted cutouts, text objects. Undo/redo throughout.
- **Cut / paste / resize** floating parts. Details below are agent decisions (SPM-9),
  pending owner confirmation:
  - **Move / Rectangle / Lasso** tools: with Rectangle or Lasso, dragging on the canvas draws
    a selection instead of moving layers or panning (wheel zoom still works). The selection
    is not an undo step; it stays until it is used, replaced, or cleared with Esc (Esc
    clears it before it clears the layer selection).
  - **Cut** works on exactly one selected image layer that the selection touches (its
    tooltip says why not). The selected pixels (whole pixels whose centres lie inside the
    selection; a lasso that crosses itself leaves the overlap out) move into a new floating
    image layer named "Cutout", **directly above** the source, at the same spot, with the
    source's rotation and scale; the source keeps a transparent hole. One undo step. The
    cutout is trimmed to its visible pixels; a selection holding no visible pixels cuts
    nothing. After a cut the cutout is selected and the Move tool is back, so it can be
    dragged and resized at once. Text layers are not cut (merge them into an image first).
    Delete still deletes layers, never selected pixels; there is no Ctrl+X/Ctrl+C.
  - **Paste**: Ctrl+V with an image on the clipboard (or the Paste button, where the
    webview allows reading the clipboard) adds it as a new layer named "Pasted image",
    native size, centred on the canvas, on top, with the same 2000×2000 import cap dialog
    as Add image as layer. PNG, JPEG and WEBP clipboard data are accepted.
  - Floating parts are moved and resized with the same handles as every layer (corner
    anchors, aspect kept, rotation), at any time.
- **Enlarge selected parts**: local warp/bulge (strength + radius), paints on the selected layer.
- **Background removal**: one-click offline ONNX auto removal + manual refine brush.
- **Outline** and **fuzzy glow**: target the selected layer, or the base image when nothing
  is selected.
- **Text**: own layer, movable/resizable until save (system fonts, size, color). Details
  (agent decisions SPM-9, pending owner confirmation):
  - **Add text** opens a text box centred on the canvas; double-click a text layer (or
    **Edit text**) edits it in place. Enter finishes, Shift+Enter starts a new line, Esc
    cancels, clicking elsewhere finishes. A new text layer is centred on the canvas and
    named after its first line. Blank text creates or changes nothing (delete a text layer
    with Delete). While text is typed, every key (Delete, undo/redo, Esc) acts on the text,
    never on the layers.
  - The font list is the system's installed families; a session's first text uses Arial
    when installed (else a common sans, else the first family). Size is a whole number of
    px within the range in src/shared/limits.json (1–1000); default 64 px, black. The font,
    size and colour controls restyle the selected text layers (one undo step), or set the
    next new text's style when no text layer is selected.
    After a committed change on the font list, size field or colour picker, the control
    gives up focus so Ctrl+Z, Delete, Esc and Ctrl+V work at once (typing in the size field
    is not intercepted).
  - Text is laid out and rasterised in Rust (left-aligned lines, the font's own line
    spacing, kerning; no ligature shaping and no fallback font for missing characters),
    and the canvas shows exactly that rendering, so the view, merge, Crop, the sizing tools
    and the save agree on its pixels and its box. Resizing a text layer scales it (it stays
    text, and is drawn sharp at its size when merged or saved); its font size field keeps
    its typed size.
- **Merge selected layers**: flatten chosen layers together mid-session so effects can be
  applied to the merged result before the final save flatten. Text layers merge too: they
  are rasterised in Rust as part of the merge (SPM-9).
- **Delete selected layers** (button or Delete key; undoable; owner decision 2026-11-20). A
  session always keeps at least one layer: deleting every layer is refused — use Close to
  start over.

### Save (hard-blocked)
- No project files: saved output is flattened and final. Re-editing opens the flattened image.
- Saving flattens what is **inside the canvas**; anything outside the canvas is clipped
  (discarded) (owner decision 2026-11-20).
- Save dialog: pick target pack (create-new inline); choose **PNG or WEBP** per save.
- **Saving is blocked unless constraints are met** — no warn-and-proceed path:
  - Sticker mode: longest side exactly **512 px** and file ≤ **512 KB**.
  - Thumbnail mode: exactly **100×100 px** and file ≤ **128 KB**, PNG/WEBP.
- The live readout shows how far the canvas is off the constraint set. **Fit** fixes it in one
  click in both modes; **Longest side** also does in Sticker mode.
- In Thumbnail mode **Longest side** is greyed out (visible but disabled, with the reason in
  its tooltip: a thumbnail must be exactly 100×100, so use Fit), so the toolbar looks the same
  in both modes (owner decision 2026-11-20).
- Closing the editor with unsaved changes warns first. Unfinished, non-conforming work
  cannot be parked — there is deliberately no scratch/draft save location.
- Thumbnail mode is the same editor with a canvas that starts at 100×100 (instead of
  512×512) and the thumbnail constraint set. Sizing tools 1 and 2 take their side from the
  active constraint set: in Thumbnail mode they are **Fit to 100×100** and **Longest side
  100** (greyed out, see above) (owner decision 2026-11-20); free resize is the same in both
  modes.

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
  (Rust vs webview) — ADR-0006 (SPM-7), leaning Rust `ort` per ADR-0005; canvas library
  choice — decided, see ADR-0005 (SPM-5: Konva in the webview for interaction, Rust
  crates for one-shot pixel work and encoding); crash-safe rename mechanics — decided,
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
- Editor: middle-mouse click-and-drag pans the view without moving the image.
- Editor: every edge of the selection box is grabbable for resizing, not just the corners.
- Editor: custom canvas resizing (in v1 only Fit and Longest side change the canvas).
- Drag and drop an image file to open it in the Editor. (v3 idea: drag and drop onto an
  open session to add it as a layer.)

## 10. Draft work packages (for review — not yet filed as issues)

1. **Scaffold**: Tauri app skeleton (Rust + TS), Windows build, SQLite, first-run library
   chooser, settings (path display, manual re-point, fresh-library creation).
2. **Library core (Rust)**: schema (packs/stickers/thumbnail/emoji/status), order-encoded
   filenames, crash-safe renames, desync detection (pack-open + manual refresh), Missing state.
3. **Pack Manager UI**: pack list/create, Draft/Live toggle + short-name lock, pack view
   (Normal/Reorder modes, detail + aggregate panels, thumbnail slot), emoji edit/copy,
   explorer reveal, delete semantics, 120 warning, bulk import with validation.
4. **Per-sticker command UX design pass** — completed 2026-11-19; command map in §5.
5. **Editor foundation**: import pipeline + 2000 cap dialog, view fit, layers, undo/redo,
   drag/pan/zoom, merge selected layers, flatten-on-save plumbing.
6. **Crop & sizing**: box overlay, destructive crop, three sizing tools, live readout.
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

# Stickerpack Maker — v1 Specification

Status: agreed in a grilling session on 2026-11-18. This document is the source of truth for v1 scope.
Vocabulary: see `GLOSSARY.md`. Durable decisions: see `docs/adr/` (0001 stack, 0002 independent copies, 0003 order-encoded filenames, 0004 crash-safe rename mechanics, 0005 editor hybrid split, 0006 background removal, 0007 library upgrades).

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
- Background removal runs offline via ONNX with a one-time model download. ONNX runs in Rust
  (`ort`, ONNX Runtime linked statically) with the ISNet general-use model (ADR-0006).
- Difficult implementation choices get ADRs and detailed task breakdowns.
- **UI conventions** (owner decisions 2026-11-21, 2026-11-22, 2026-11-25):
  - Every two-option confirmation in the app (deletes, Draft/Live, invalid import, creating
    a Library) uses the one shared in-app dialog: the safe choice is the default (focused,
    primary), and Esc and closing choose the safe option. Buttons read action first, safe
    choice last (one exception: the "even WEBP is too large" question, §6 Save). Forms
    that collect input (New pack, Send to pack) are not confirmations: their submit button
    stays primary.
  - Disabled controls look disabled (faded).
  - Every control's tooltip reads **Name (Shortcut) — one-line description**; when the control
    is disabled, the blocker reason replaces the description entirely, so the tooltip still
    says what is missing (owner decision 2026-11-25).
  - Every message that stays until dismissed has an **X** close button on its left as well as
    **Dismiss** on its right; both do the same (owner decision 2026-11-22). The red message
    line (errors and blocked-action reasons, in the Editor and the Pack Manager) is not such a
    message: it stays until the next command replaces or clears it, and has neither (owner
    decision 2026-11-22; reaffirmed 2026-11-25). In the Editor it sits in a reserved row under
    the toolbar with a fixed minimum height that never collapses — the old collapse-when-empty
    behaviour is gone, so the interface never jumps when a message appears or disappears
    (§6 Layout); no overlay redesign, no close buttons (owner decision 2026-11-25).

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
  Telegram). v1: manual toggle both ways; each direction asks for confirmation (owner decision
  2026-11-21): Draft→Live confirms that going Live locks the Short Name, Live→Draft warns.
  Both are in-app dialogs with exactly two buttons and no Cancel. Draft→Live is titled "Go Live?"
  with **Go Live** and **Keep Draft**; Live→Draft is titled "Revert to Draft?" with **Make Draft** and
  **Keep Live**. The keep button (Keep Draft / Keep Live) is the default (focused, primary), also on
  Esc and close (owner decision 2026-11-21).
  Live status otherwise changes nothing in v1 beyond the badge and the short-name lock.
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
- An older Library's database is upgraded to the current schema when the app opens it: the
  migrations it lacks are applied once, in order, in one transaction (owner decision
  2026-11-21; ADR-0007).

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
  Reorder mode is obvious at a glance: every sticker tile turns a theme-matched green, and a
  faded copy of the dragged sticker follows the cursor (owner decision 2026-11-21).
- The two modes are mutually exclusive; the toggle is always visible.
- Sticker tiles have one fixed size and show position, preview and at most one warning
  flag: **Missing** takes priority over the emoji-count flag. The Emoji String shows in the
  detail panel, not on the tile (owner decisions 2026-11-21 and 2026-11-22).
- The side panel is full-height and always beside the grid, at every window width; the grid
  scrolls on its own (owner decision 2026-11-21). Both reserve their scrollbar's space, so
  nothing narrows or jumps when a scrollbar appears (owner decision 2026-11-22).
- Pack toolbar, in this order: **Refresh** (refresh icon before the label), **Add images…**,
  the sticker count (fixed width), **Open in explorer** (opens the pack's folder), and
  **Reorder** last, so its "Done reordering" label never moves another control (owner
  decision 2026-11-22). The Reorder-mode instructions (including that selection is off)
  show in the side panel, not the toolbar, so the toolbar never changes.

### Detail panel (single selection)
- Large preview; metadata: position, format, dimensions, file size.
- **Emoji String**: inline editable box of four rows of five that shows all 20 emoji at once
  (type, or Win+. for the Windows emoji panel); past 20 it grows a row instead of scrolling.
  Every space is stripped when it is saved and the count ignores spaces. Beside the box: a
  small square icon-only **copy** button and the live 1–20 count; the count warning shows
  below (owner decisions 2026-11-21). Emoji are drawn with the colour emoji font first, never
  as monochrome text glyphs (owner decision 2026-11-22). The emoji font is a Settings choice
  (SPM-17, owner decisions 2026-11-21): **Android** — bundled Noto Color Emoji (SIL OFL 1.1),
  the default, covering emoji the installed Segoe UI Emoji lacks (e.g. 🫵, Unicode 15);
  **Twemoji** — bundled, artwork CC-BY 4.0 with the credit shown in Settings and the licence
  texts shipped beside the fonts; **Windows** — the system's Segoe UI Emoji, nothing bundled;
  **custom font file** — a user-picked .ttf/.otf/.woff2, read from where it is and never shipped;
  a custom file that is missing, not a font, or refused by the app's embedded web engine (some
  fonts Windows itself renders are rejected inside the app — not a bug drawable around) falls
  back to Android with a message in Settings.
  The choice changes every emoji in the app without a restart (one font-family stack on the
  emoji fields' shared variable, re-measuring the Emoji String box; since SPM-20, Editor
  text layers' emoji follow the same choice — the Rust text renderer draws them in colour
  from the style's chain), and persists in the app
  config next to the Library path.
- Actions: **Edit** first asks **Edit / Replace… / Cancel** (Cancel is the safe default):
  Edit opens the flattened image in the Editor, Replace runs the Replace flow below (owner
  decision 2026-11-21). A session opened with Edit remembers that sticker: saving it
  offers to replace the sticker in its slot (§6 Save; owner decision 2026-11-22).
  Opening in the Editor while it has unsaved changes asks first, in the shared dialog: "The
  editor has unsaved changes. Do you want to discard these or continue editing?" (Discard /
  Keep editing, Keep editing by default); either way the view then switches to the Editor,
  which opens the sticker only after Discard. **Replace** (preserves position + emoji;
  validated drop-in or via Editor, §5 replacement rules below); **Send to pack…**; **Open in
  explorer** (folder opens with the file selected; the button ends with an "opens in another
  program" icon, as every Open in explorer button does); **Delete** (confirmation dialog
  showing preview + emoji, then permanent; Delete key shortcut). No double-click behavior in
  v1.

### Aggregate panel (multiple selection)
- "N stickers selected" + combined file size. Exactly two actions: **Send to pack…** and
  **Delete** (bulk confirmation showing the affected stickers). Per-sticker actions require
  single selection.

### Send to pack (single and bulk; the unified Duplicate/Move command)
- Dialog: the pack picker (a searchable pack field with Draft/Live badges, described in §6
  Save), current pack excluded, with inline **New pack…** (Title → auto Short Name, Draft)
  beside it (owner decision 2026-11-22). The dialog always opens with focus in the pack
  field, even when a pack is already chosen, so Enter never sends at once (owner decision
  2026-11-22).
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
- *Editor*: edit the existing flattened image, or edit a new image, then save into the slot. The
  hard-blocked drop-in's "open in editor" opens the picked file with the slot as the session's
  origin, so saving offers **Replace #N in <pack>** (the default), per §6.

### Missing stickers
- Warning badge on the tile; panel banner with **Replace file** (the validated drop-in path)
  and **Delete** (removes the slot and renumbers the pack to fill the gap). Edit and Send
  are disabled with the reason shown.

### Thumbnail slot
- Same panel paradigm minus emoji and position: Create (new image or a copy of any pack
  sticker, via Editor thumbnail mode), Replace, Delete, Open in explorer. Visually distinct
  slot at the end of the list; unnumbered file (§4).

### Pack-level
- **UI conventions**: the app-wide dialog and dismissible-message rules are in §2.
- Create pack (Title → auto Short Name, editable while Draft; new packs are Draft).
- Pack list: shows how many packs the Library holds, but no per-pack sticker counts (each
  pack's view shows its own); each pack has **Open in explorer**, which opens the pack's
  folder (owner decisions 2026-11-21).
- Pack header: **← Pack list** back button; Title always editable; Short Name editable only
  in Draft, with "🔒 Locked" beside its label (the full reason as its tooltip) so the header
  never changes height (owner decisions 2026-11-22); the Draft/Live badge and its button sit
  right after the Short Name, labelled **Go Live** / **Revert to Draft** like the dialogs they
  open (owner decision 2026-11-21). Draft/Live manual toggle both ways, each direction
  confirmed (owner decision 2026-11-21); Draft→Live offers
  Go Live / Keep Draft, Keep Draft by default; Live→Draft offers Make Draft / Keep Live, Keep Live
  by default (owner decision 2026-11-21).
- **Bulk import**: drag-drop multiple images onto a pack, or pick them with Add images. Same
  validity rule as drop-in — valid files added as-is in natural filename order ("sticker2"
  before "sticker10"), because Windows hands dropped files over in its own drag order, not
  Explorer's view order (owner decision 2026-11-21); invalid files rejected per-file with an
  "open in editor" option. Imported stickers get no emoji; empty-emoji stickers are flagged.
- Pack-view messages that stay until dismissed (notices such as "Checked the pack folder…",
  and the "Not added" list) have an **X** on the left as well as **Dismiss** on the right
  (owner decision 2026-11-22).
- Desync checks on pack open + manual refresh only, never on app start (§4).
- 120-sticker warning; pack deletion semantics per §3.

## 6. Editor

### Layout: top row, panels, status strip (SPM-15)
The Editor's frame is one top row, a reserved message row, a left tools panel, the canvas, a
right tabbed panel and a bottom status strip. The record below is the agreed design for this
pass.

- **One top row** (the Editor toolbar), left to right: **Undo**, **Redo** | **Fit in 512**,
  **Cover 512**, **Long side 512** | the free-resize cluster, reading as one sentence —
  **[Long/Short] side [N] px Resize** | **Guide**, **Crop to {size}** | a flexible spacer |
  **Save…**, **Close**. Thin vertical rules divide neighbouring groups, exactly 8px from the
  controls on both sides (owner decision 2026-11-25). Undo, Redo, Save… and Close become icons
  in a later pass; the seven renamed sizing and crop controls stay text (owner decision
  2026-11-25). The row holds its one line from the window's 1100px minimum up (Window, below).
- **The reserved message row** sits under the top row: fixed minimum height, never collapsed
  (§2; the CMT-290 canvas jump).
- **A bottom status strip**: the live readout (Crop and sizing, below) on the left; on the
  right, in this order, the zoom level, the **Reset view** button and the unsaved-changes dot
  (owner decision 2026-11-25 — Reset view sits in the status cluster, never floating at the
  canvas/panel boundary).
- **A left tabbed tools panel (192px)**: browser-style tab leaves stuck on the panel's top
  edge and protruding past it over the canvas until the icon pass. The tabs:
  - **Select**: Move, Rectangle, Lasso, Wand; the Tolerance and Feather fields; the contextual
    actions Cut and Paste.
  - **Paint**: Erase, Restore, Warp; the Brush field; Remove background, which stays
    conceptually with its brushes (owner decision 2026-11-25), with Cancel download beside it
    while the model downloads.
  - **Effects**: Outline and Glow.
  - **Text**: Add text, Edit text and the six text style controls — the CMT-366 resolution:
    text-outline styling lives under Text, the Outline EFFECT tool under Effects.
  - Tool **settings live in the panel under their tool**: Warp's strength and radius while
    Warp is active, Outline's or Glow's controls with Apply/Cancel while that effect is active
    (Layers and tools, below). The horizontal effect bar is **retired**: its appearing and
    disappearing used to shift the canvas, the CMT-290 disease, and a change inside the panel
    never moves it. Sliders stay wheel-scrollable with direct-entry fields (2026-11-23
    decision), narrower for the panel (owner decision 2026-11-25).
- **Panel switching** (owner decision 2026-11-25): a tab click shows its category and stays
  there; ANY tool activation — its button, its shortcut, or the automatic return to Move after
  Cut, Apply or a discarded preview — surfaces that tool's category; opening text editing (Add
  text, Edit text, a double-click on a text layer) surfaces Text and the panel goes back to the
  active tool when the edit ends, because the panel follows the active editing surface, not
  just the pointer tool. Selecting or deselecting layers never switches — text layers
  included, the owner dropped the auto-switch — and neither do undo/redo, saving, or a view
  change.
- **Single-key tool shortcuts**, active only while no text field or typing overlay has focus
  (like Delete and Ctrl+Z today): **V** Move, **R** Rectangle, **L** Lasso, **W** Wand,
  **E** Erase, **Shift+E** Restore, **B** Warp, **O** Outline, **G** Glow, **T** activates the
  Text category. The bindings sit in a changeable data-driven table; a rebinding UI is parked
  for v2 (§9). The existing modified shortcuts (Ctrl+Z/Y/X/V/S, Delete, Esc) are unchanged.
- **A right panel (240px)** with tabs **Layers / Actions / Emoji**:
  - **Layers**: the layer list in a bounding box; the action buttons BELOW the box's bottom
    edge, a two-column grid — the left column changes the stack's size (a tall **Add image as
    layer…**, its ellipsis marking the picker dialog, over **Delete**), the right column
    manipulates layers (**Move up**, **Move down**, **Merge selected**) (owner decision
    2026-11-25). CMT-193's move of Add image as layer into the Layers panel lands here.
  - **Actions**: a READ-ONLY list of every undoable document action, oldest first, with a
    current-position marker. The history records a human-readable label IN-BAND at apply()
    time (`{state, label}` entries). The selection's own steps (SPM-23) nest under a Select
    entry and vanish with the trail's rules — the next document action clears them — and the
    memory budget can drop the oldest entries. Clickable jump-to-state is a PLANNED LATER
    promotion, not v1 (owner adopted the labels-now/read-only-now plan, 2026-11-25).
  - **Emoji**: a typed text box, with a fixed five-row height that never resizes, for the
    session's sticker Emoji String — the anti-jump rule; an internal scrollbar is the overflow
    safety valve only. When the session edits an origin sticker, edits commit IMMEDIATELY on
    Enter or blur: pack metadata, neither an undo step nor a dirtying change. For a fresh
    image the typed emoji is STAGED and assigned to whatever sticker the image becomes at save
    (the save dialog's "without emoji" hint changes accordingly, Save below). A gone origin
    disables the box with its reason. Validation is warn-only 1–20 with empty allowed, as
    everywhere (§7). In Thumbnail mode the tab is HIDDEN (owner decision 2026-11-25 — parity
    for geometry, honesty for content: buttons-in-rows stay visible-when-disabled, but a tab
    to content that does not exist in the mode may not show). The Editor view is built once
    and cached, so the tab's visibility must be recomputed from the session's mode on every
    refresh; the Windows live test must check that swapping Thumbnail → Sticker does not leave
    the tab hidden for stickers (owner's live-test note, 2026-11-25).
- **Both modes keep identical GEOMETRY** in the top row, the panels and the strip (owner
  decision 2026-11-20, CMT-72): Thumbnail mode greys out **Long side 100** in place, visible
  and disabled with its reason (Save, below). The ONE exception is the Emoji tab's hiding
  above (owner decision 2026-11-25).
- **Window**: the app opens at **1350×1000** by default (was 1200×800; owner decision
  2026-11-25 — it fits a 1080p work area), and its minimum width becomes **1100px** (was 900;
  owner decision 2026-11-25 — the agreed minimum for the one-row toolbar).
- **Implementation notes** for this pass: **Close** gains the app's danger colour treatment
  (owner decision 2026-11-25), with a boundary that passes the project's 3:1 UI rule in BOTH
  themes — the `--danger-border` token measured 2.70:1 on `--bg` in dark, the same class of fix
  primary buttons got with `--accent-ink`; and the save dialog's clipped focus outline on
  **New pack…** (CMT-282) is fixed here.

### Import and canvas
- Source formats: .jpg, .jpeg, .jfif, .png, .webp.
- The canvas starts square at the active constraint set's side: **512×512** for stickers,
  **100×100** for thumbnails (owner decision 2026-11-20); it is never set from the imported
  image. The opened image is placed at its native pixel size, centred on the canvas, and may
  overflow it.
- Imports larger than **2000×2000** (the import cap) trigger the shared two-option dialog
  (§2): **Scale to fit** scales to fit within 2000×2000 preserving aspect ratio (longest
  side 2000); **Cancel**, the default, aborts the import.
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
  Drag the image to choose what survives. The overlay is **on by default** and the **Guide**
  button shows or hides it (owner decision 2026-11-20; renamed 2026-11-25 from Crop box, a
  name that read as if clicking it would crop); the toggle hides the canvas outline too, one
  toggle for both, while the checkerboard still shows where the canvas is (owner decision
  2026-11-21). The box is the set's side,
  **capped at the canvas size on each axis**, so it is never larger than the canvas: a
  512×439 canvas gets a 512×439 box (owner decision 2026-11-20). It follows the canvas size,
  staying centred; when the canvas and box sides differ by an odd number, its top-left is
  rounded down to a whole pixel, so it always covers whole pixels. The **Crop** button keeps
  its dynamic label naming the actual guide size (e.g. **Crop to 512×512**, or
  **Crop to 512×439** on a cropped canvas) (owner confirmed 2026-11-21; naming 2026-11-25).
- **Crop** is destructive: everything outside the box (512×512 for stickers, 100×100 for
  thumbnails, capped at the canvas size as above) is discarded; the canvas size stays as it
  is (owner decision 2026-11-20).
  - A layer inside the box is left exactly as it is. A layer crossing the box edge keeps
    only the whole pixels it covers inside the box: it becomes an unrotated, unscaled layer
    at that spot, with its rotation and scale baked into its pixels. It keeps its name and
    its place in the stack (owner confirmed 2026-11-21).
  - Layers **entirely outside** the box are discarded in the same single undo step (owner
    decision 2026-11-20). If every layer is entirely outside, Crop is disabled ("Nothing is
    inside the box"), because a session always keeps at least one layer.
  - Crop is disabled, with the reason in its tooltip, when nothing lies outside the box (owner confirmed 2026-11-21).
  - Crop never moves the view: the canvas origin does not move.
  - Text layers on Crop (owner confirmed 2026-11-21): a text layer
    is measured by its rendered box, turned and scaled with the layer, like an image by its
    pixels, so every rule above applies to it unchanged. Inside the box it stays
    editable text; entirely outside it is discarded like an image; crossing the box edge it
    is rasterised (in Rust) and clipped like an image, becoming an image layer with the same
    name and place: text cannot both stay editable and lose its outside part. The "at least
    one layer" rule is unchanged. After such a Crop a neutral (not red) note in the
    message line says how many text layers were converted, e.g. "1 text layer crossed the
    crop edge and was converted to an image."; Undo brings the text back and clears the note (owner decision
    2026-11-22).
- Sizing tools (whole image, aspect preserved, transparency padding where relevant). "Whole
  image" = everything on the canvas treated as one layer, exactly like selecting every layer
  and resizing them together (owner decision 2026-11-20). Sides below are Sticker mode's;
  Thumbnail mode uses 100 for tools 1, 2 and 4, so they read **Fit in 100**, **Cover 100** and
  **Long side 100** (see Save):
  1. **Fit in 512**: scale the whole image so its longest side is 512, set the canvas to
     512×512 and centre the image; the user can then reposition it, and the rest is
     transparent padding.
  2. **Long side 512**: scale the whole image so its longest side is 512, then set
     the canvas to the scaled image's size in whole pixels (no padding).
  3. **Free resize**, which reads as one sentence in the top row: a side-kind select with the
     options **Long** and **Short**, the static text "side", the px number field, the static
     text "px", then **Resize** (owner decision 2026-11-25). It scales the whole image so its
     longest or shortest side (owner request 2026-11-21) is the entered value, a whole number
     of pixels from 1 to 2000. The canvas size does not change; the image keeps its
     centre where it was.
  4. **Cover 512**: Cover is to Fit what CSS cover is to contain (owner request
     2026-11-21): scale the whole image so its shortest side is 512, set the canvas to
     512×512 and centre the image. Spillover outside the canvas is KEPT (non-destructive):
     the user drags the image to choose which part shows; Save clips the rest (§Save), and
     Crop is available if wanted. Enabled in both modes (**Cover 100** in Thumbnail mode):
     the result always meets either constraint set.
- Only sizing tools 1, 2 and 4 change the canvas size (owner decision 2026-11-20; tool 4,
  2026-11-21). Nothing else
  does: not opening an image (the canvas starts at the constraint set's side), adding a
  layer, merging, deleting, Crop, free resize, or undo/redo of any of these.
- The sizing tools change the canvas or the image, **never the view**: zoom and pan stay where
  the user left them (owner decision 2026-11-20). The canvas keeps its top-left corner where
  it was on screen, so the outline grows or shrinks by the same factor as the canvas.
  Undo/redo of a sizing tool behaves the same.
- **Middle-mouse click-and-drag pans the view** without moving any layer (owner decision
  2026-11-21). It works anywhere on the stage, over layers too, in every tool; it never
  selects or moves a layer, and it triggers no browser autoscroll. It counts as a manual view
  change like a left-drag pan or wheel zoom (an automatic fit never overrides it; only Reset
  view re-fits), and the zoom readout updates.
- **Reset view** is the only way to re-fit: it re-centres the canvas and zooms to fit it in
  the view (never above 100%), without changing the image. The view is fitted automatically
  only when an editing session opens.
- **Live readout** of the canvas size against the active constraint set (owner decision
  2026-11-20): Sticker mode means longest side 512; Thumbnail mode means exactly 100×100.
  It shows the canvas size and either that it meets the set or how many pixels each side is
  over or under (e.g. "600×400 px · needs longest side 512: 88 px over"), and updates on
  every change, undo and redo included (owner confirmed 2026-11-21).
- **Selected layer's size** (owner requests 2026-11-21, decided 2026-11-23): the layer list
  shows the one selected layer's current pixel size, live — it updates on any resize,
  rotation, move, undo and redo. A rotated or scaled layer shows its ON-CANVAS BOUNDING BOX
  (owner decision 2026-11-23, against the scaled-size recommendation): the axis-aligned box
  it occupies on the canvas, rotation included, in whole pixels — the same box Crop measures
  a layer by. Nothing is shown with no layer or several layers selected.

### Layers and tools
- Session layer model: base image, pasted cutouts, text objects. Undo/redo throughout.
- **Cut / paste / resize** floating parts. Details below are owner
  confirmed 2026-11-21 (SPM-9; the Wand, 2026-11-24, SPM-22):
  - **Move / Rectangle / Lasso / Wand** tools: with one of the latter three, the left
    button draws a selection instead of moving layers or panning; wheel zoom and
    middle-drag pan still work, even mid-drag (only the left button's release ends a
    drag). A bare Alt has no side effects on Windows: the editor marks it handled, so
    the system menu never engages and the wheel keeps zooming (owner re-test ruling
    2026-11-24). The selection stays until it is used, replaced, or cleared with Esc
    (Esc clears it before it clears the layer selection). It is not a step of the
    document's history, but it has its own step trail (SPM-23, owner decisions
    2026-11-24): Ctrl+Z and Ctrl+Y (Ctrl+Shift+Z too) step the selection back and
    forward while selection steps exist, then fall through to document undo/redo, and
    the toolbar's Undo/Redo buttons follow the same route. One step per committed
    selection change — a tolerance drag is one step — and every step-back keeps the
    redo trail. The stored selection stays visible under every draft being drawn (the
    draft draws over it): the modifier is read at release, so a plain draw shows the
    old selection until its release replaces it. The trail follows the owner's rule
    (2026-11-24): Esc clears it all, and a document edit clears the trail outright —
    even when a plain Rectangle/Lasso survives the edit; a Cut or Delete that consumes
    the selection clears it; a document undo or redo clears it only when it removes the
    selection.
  - The **Lasso** is a hybrid (owner decision 2026-11-22, in the style of GIMP's Free
    Select): a click adds a waypoint (a straight edge from the last point), a drag draws
    freehand, and the two mix in one lasso, which stays open between presses with a
    rubber band to the pointer. It closes by pressing on its start point (or releasing a
    freehand stroke there), by a double-click on one spot (two clicks, not a stroke), or by
    Enter. While it is open, Esc cancels it (the previous selection stays) and Backspace
    removes its last segment: the last waypoint, or the whole last freehand stroke while
    the point the stroke began at stays a waypoint, as in GIMP (owner re-tests
    2026-11-22). A plain closed lasso with no area clears the selection.
  - The **Wand** (SPM-22, owner decisions 2026-11-24) selects the colour-similar pixels
    around a click: the target follows the effects tools (the selected image layer, else
    the base image) and the click also selects it. A pixel matches when it is visible and
    no RGB channel drifts more than the tolerance — a percent of full range, default 20, in
    the Tolerance field beside the tools — from the clicked sample; the fill is contiguous,
    stopping at the first
    non-matching pixel, and the mask carries a 1-px feather (half coverage on its
    boundary), so erasing up to manga ink lines leaves no razor cut through the
    anti-aliased band. The Feather checkbox beside Tolerance switches the feather
    off for hard edges; it is on by default (owner decision 2026-11-24) and governs every
    contribution a selection is built from, below. A selection that runs to the layer's own
    edge stays fully covered there, so erasing a background to the panel's edge leaves no
    faint half-covered line along it. A click-drag sets the tolerance live, with a readout
    beside the pointer (up increases, down decreases — the warp strength's own convention),
    re-filling the layer
    in coarse steps as it changes (a performance choice, not a promise of any particular
    step). A plain click replaces the selection; with a selection drawn, Shift adds the
    clicked region to it and Alt removes it (with both held, Shift wins) — the way back
    from an accidental compose is the selection's own step-undo (above), not the
    document's undo. The region draws like the others (a dashed outline, one loop per
    boundary of the merged area) and dies with any edit or undo, its step trail with it.
    A fully transparent or out-of-layer click, and a text layer or several
    selected layers, say why in the message line and change nothing.
  - **The selection composes across the tools** (SPM-23, owner decisions 2026-11-24): a
    selection is one floating area, independent of the layer or the tool that built it — a
    stack of contributions, each tagged add or subtract: a wand fill in the grid it was
    filled in (with that layer's transform), or a Rectangle/Lasso polygon in document
    pixels. Shift and Alt compose whatever is drawn onto whatever is already there: the
    modifier is read at release for Rectangle, at close for Lasso (Enter, double-click,
    release-on-start and press-on-start each read their own event's Shift/Alt), and at
    press for the Wand; with no selection drawn, every modifier acts as a plain draw.
    With a selection drawn, a modifier gesture that ends with no area drawn — a bare
    click, or a lasso that closes empty — keeps the existing selection (owner decision
    2026-11-24): a modifier gesture that adds nothing changes nothing, so an accidental
    under-slop click while trying to Shift-drag onto the selection does not wipe it. A
    plain unmodified click or empty lasso still clears the selection as before. Cut and Delete
    resolve the target at press: the ONE SELECTED IMAGE LAYER the selection touches — the
    Rectangle/Lasso rule made universal, whichever tool or layers built the selection (no
    layer, or several, says to select the one image layer; a selection that touches none
    says so; there is no cross-target refusal). The merge runs in the target layer's own
    pixel grid, so a polygon cuts exactly as a plain Rectangle/Lasso does and a wand fill
    applied to its own layer moves the very same pixels (only a fill carried to another
    layer resamples, softly); the dashed outline shows the merged area, holes included. A
    composed selection inherits the wand's lifetime — any edit or undo drops it — while a
    plain unmodified Rectangle/Lasso stays plain geometry in document pixels and survives
    edits, its whole-pixel Cut/Delete unchanged. The Feather checkbox governs a polygon
    contribution's boundary too (soft when on, hard when off). Three wand flows change with
    the unified rule (owner decisions 2026-11-24): a wand region with another layer
    selected now cuts or erases from that selected layer, where the selection touches it;
    with no or several layers selected Delete is refused with the select-one-image-layer
    reason; and Shift + wand-click on another layer adds that region to the selection
    instead of starting fresh. Every committed change of the selection is ONE step of its
    own trail — each wand click, each Rectangle/Lasso commit, a tolerance drag as one
    step — and a subtract that empties the selection is a step too, so Ctrl+Z brings the
    selection back; the steps are taken back and forward before the document's own
    undo/redo runs, and the trail dies with the selection (the selection bullet above).
  - **Cut** works on exactly one selected image layer that the selection touches (its
    tooltip says why not). The selected pixels (whole pixels whose centres lie inside the
    selection; a lasso that crosses itself leaves the overlap out) move into a new floating
    image layer named "Cutout", **directly above** the source, at the same spot, with the
    source's rotation and scale; the source keeps a transparent hole. One undo step. The
    cutout is trimmed to its visible pixels; a selection holding no visible pixels cuts
    nothing. After a cut the cutout is selected and the Move tool is back, so it can be
    dragged and resized at once. Text layers are not cut (merge them into an image first).
    Delete erases a drawn selection's pixels from the one selected image layer it touches
    (owner decisions 2026-11-24, amending the 2026-11-21 rule that Delete never touched
    pixels): whole pixels for a plain Rectangle/Lasso selection, the merged coverage for a
    composed one (a wand fill's feathered mask, a polygon's rasterised boundary), keeping
    the layer's restore source so Restore brings them back, as ONE undo step; with no
    selection drawn it deletes the selected layers, never pixels. Ctrl+X
    runs Cut (lifting the
    selection to a new layer, not to the clipboard; when Cut is blocked it shows the
    tooltip's reason in the message line), and there is no Ctrl+C (owner decision
    2026-11-21).
  - **Paste**: Ctrl+V with an image on the clipboard (or the Paste button, where the
    webview allows reading the clipboard) adds it as a new layer named "Pasted image",
    native size, centred on the canvas, on top, with the same 2000×2000 import cap dialog
    as Add image as layer. PNG, JPEG and WEBP clipboard data are accepted. Ctrl+V also
    pastes an image file copied in the file explorer; the Paste button cannot see copied
    files (the webview's clipboard API reads only image data), so when it finds no image it
    says "No image data on the clipboard. Copied an image file? Press Ctrl+V." (owner
    decision 2026-11-22).
  - Floating parts are moved and resized with the same handles as every layer (corner
    anchors, aspect kept, rotation), at any time.
  - Handle modifiers are Konva's built-in ones (owner decision 2026-11-22): holding **Alt**
    while dragging a corner handle resizes the layer around its centre instead of
    anchoring the opposite corner; holding **Shift** while dragging the rotation handle
    snaps the rotation to 15° steps.
- **Enlarge selected parts**: local warp/bulge (strength + radius), paints on the selected layer.
  Details (SPM-8; owner decision 2026-11-21: a destructive brush): the **Warp** tool paints
  on the selected image layer, or the base image (the bottom layer) when nothing is
  selected; text layers are not warped (merge them into an image first), and with several
  layers selected it says to select one. Each press places ONE bulge, which magnifies the
  pixels around the press point in place (meme style), within its radius (owner decision
  2026-11-22): a click uses the panel's strength and radius (radius in on-screen document
  px); a press-drag keeps the bulge at the press point and sets its **radius** to the
  pointer's distance from it, live, with the ring following; holding **Shift** during the
  drag sets the **strength** instead, which follows the pointer's vertical movement — up
  increases, down decreases (owner decision 2026-11-23) — relative to its value when
  Shift went down (about 1% per 2 screen px, 1–100%), with the radius frozen; letting
  go of Shift goes back to the radius, continuing from its frozen value, so nothing
  jumps. Shift is read from each
  pointer event (held, not tapped), and may already be down at the press. A readout
  beside the pointer shows "Radius N px" or "Strength N%". A drag's final radius and
  strength become the panel's values. The layer keeps its size and transform (one piece);
  each press is one undo step on release. (Shrinking/pinch is parked for v3.)
- **Background removal**: one-click offline ONNX auto removal + manual refine brush. Details
  (SPM-7, ADR-0006; owner decisions 2026-11-22):
  - **Remove background** works on the selected image layer, or the base image when nothing
    is selected (like Outline and glow); with text or several layers selected it is
    disabled, with the reason in its tooltip. It makes the background transparent (the
    alpha only; colours stay) as one undo step. When the model finds no subject, the red
    message line says so and nothing changes.
  - One model: **ISNet general use** (no model choice in the UI; the anime model offered on
    2026-11-22 was dropped by the owner on 2026-11-23 — colour anime is out of scope, and
    manga is handled by the Wand tool above, SPM-22).
  - The model runs offline in Rust. Its first use asks in the shared dialog (§2),
    "Download the background removal model?", naming its size, with
    **Download** and **Cancel** (the default); its one-time download (179 MB)
    shows its progress as a neutral note in the message
    line, with a **Cancel download** button beside Remove background while it runs. It is
    checked against a pinned checksum and kept in the app data folder; after that removal
    never uses the network. A failed download says why in the red line and changes nothing.
  - **Erase** and **Restore** are canvas tools in the Paint category, with Warp (§Layout).
    They paint on the same layer Remove background would use: Erase makes pixels transparent,
    Restore paints back the layer's pixels from before its first background removal or Erase
    stroke. The brush is round with a one-pixel soft edge, sized in canvas px (**Brush**
    field, 1–500, default 40), with its outline at the pointer; going over a spot again in
    the same stroke does not erase it further. Each finished stroke is one undo step.
    Wheel zoom and middle-drag pan work while painting. A press that cannot paint (text or
    several layers selected, or nothing to restore yet) says why in the red line.
  - A layer keeps what Restore paints back while it is moved, resized or rotated, and
    loses it when Cut, a Crop across it, a merge or an effect replaces its pixels. Restore
    then says so on a press, and to undo that step first (owner decision 2026-11-22).
- **Outline** and **fuzzy glow**: target the selected layer, or the base image when nothing
  is selected. Details (SPM-8):
  - One-shot (owner decision 2026-11-22): while the **Outline** or **Glow** tool is active,
    a live preview shows the effect with the current settings (outline: colour, width;
    glow: colour, radius, softness, opacity); **Apply** bakes it into the layer's pixels as
    ONE undo step and returns to the Move tool (since SPM-18, Outline on a text layer
    commits a style change instead — see the tool's bullet below); changing settings is
    not an undo step.
    Normal blending only (owner decision 2026-11-21). The preview is drawn by Rust with
    Apply's own code, so the preview is the result (ADR-0008).
  - The settings sliders take more than dragging (owner decision 2026-11-23): scrolling the
    mousewheel over one steps its value by 1 within its range (hover is enough, up
    increases, nothing else scrolls), and the value shown beside each slider is an
    editable field — a typed whole number commits on Enter or blur, clamped into the
    range; invalid or empty reverts, and Esc reverts and blurs. The Warp panel's sliders
    work the same way.
  - Every colour picker in the Editor (outline, glow and text) has an eyedropper beside
    it (owner decision 2026-11-23; canvas-only per CMT-296: the browser EyeDropper API
    ships in WebView2 but its sampler does not work in the embedded runtime): clicking it
    starts a pick on the canvas — a crosshair cursor with a magnifier loupe following the
    pointer, showing the zoomed pixels and the #rrggbb under it — and a click samples the
    composited pixel as shown (every layer and a visible effect preview included; the
    guides, rings and the loupe excluded) and applies it exactly as typing it into the
    picker would, so the tool and its preview stay, recoloured. Wheel zoom and middle-drag
    pan keep working during the pick; a fully transparent spot refuses, saying so in the
    message line, and the pick stays for another try; Esc, switching tools or ending the
    session cancels the pick.
  - The unapplied preview (owner decision 2026-11-22) exists only until Apply: switching
    tool (or **Cancel**), picking another layer as the target (in the Layers list;
    re-picking the layer that is already the target, such as the base image while
    nothing was selected, keeps the tool and its preview, and while several layers are
    selected there is no target yet, so choosing one makes it the target; owner decision
    2026-11-22),
    undo/redo, any other edit, and closing the Editor all discard it, and it never enters
    the undo history. An **Esc** that clears a layer selection is a discard too, whatever
    layer was selected — the base image included — while Esc with nothing selected
    changes nothing, and re-picking the already-target layer is not a discard (owner
    decision 2026-11-23). Every discard also returns to the Move tool (owner decision
    2026-11-22). An unapplied preview alone does not make the document dirty, so closing
    warns only about applied, unsaved changes. Settings keep their latest values until the
    app closes (never saved; each app start uses the defaults).
  - The effect grows the layer: an outline or glow reaching past the layer's edge makes
    the layer larger (its top-left moves out), not clipped; the save still clips to the
    canvas. Sizes are in on-screen document px, so a scaled layer looks the same.
  - The layer is chosen before the tool (owner decision 2026-11-22): in Outline and Glow
    a click on the canvas selects nothing and nothing moves (empty space still pans).
    With several layers selected the tool says to select one (merge them first to treat
    them as one). A text layer gets the effect too, split since SPM-18: **Outline** sets
    the layer's outline style instead — the preview is the restyled text and Apply commits
    it as one undo step, the layer staying editable text at the same place, with no
    conversion note, the panel's width field staying document px and being converted into the
    style's own px on commit (divided by the layer's scale), so its on-screen reach is the
    same at any layer scale, within the style's whole-px rounding, as on a raster layer —
    a conversion below 1 own px lands the smallest real outline, never none (0 stays the
    width field's own way to remove one); a shrunk layer's widest settings can convert
    past the style's 0–100 range, and the message line refuses them, committing nothing;
    **Glow** still rasterises the layer in
    Rust and it becomes an image layer with the same name and place; a neutral note says
    so.
- **Text**: own layer, movable/resizable until save (system fonts, size, color). Details
  (owner confirmed 2026-11-21, SPM-9):
  - **Add text** opens a text box centred on the canvas; double-click a text layer (or
    **Edit text**) edits it in place. Enter finishes, Shift+Enter starts a new line, Esc
    cancels, clicking elsewhere finishes. A new text layer is centred on the canvas and
    named after its first line. Blank text creates or changes nothing (delete a text layer
    with Delete). While text is typed, every key (Delete, undo/redo, Esc) acts on the text,
    never on the layers. The text box follows the view when it is panned or zoomed while
    typing, and the wheel zooms even with the pointer over the text box.
  - The font list is the system's installed families, shown in a font picker where each
    name is drawn in its own typeface and typing filters the list (names starting with
    the typed text first); arrow keys move, Enter or a click picks, Esc or leaving the
    field keeps the current font (owner decision 2026-11-22); its open list is WIDER than its
    closed field, so long names stay readable while scrolling, with truncation after a pick
    allowed — scoped to the font picker only, the pack picker unchanged (owner decision
    2026-11-25); a session's first text uses Impact when installed (else a common sans, else
    the first family). Size is a whole number of px within the range in
    src/shared/limits.json (1–1000); default 64 px, black. The
    outline controls (SPM-18, owner decision 2026-11-22, SPM-8 grilling R2-Q11) sit with
    them: an outline colour picker and an outline width, a whole number of px from 0 to
    the range in src/shared/limits.json (0–100); 0 means no outline — also how an outline
    is removed — and a new text starts with none. The width is in the layer's own px like
    the font size, so a resized text layer scales its outline with it, and the outline
    colour applies when a width is set. The font, size, colour and outline controls
    restyle the selected text layers (one undo step), and every change also sticks for
    the next new text, so the last font, size, colour and outline used carry over (owner
    re-test 2026-11-22). Only the property changed carries over; selecting a
    text layer alone changes nothing, so while one is selected the controls show its style
    and Add text still uses the next-text style (owner decision 2026-11-22). To set the
    next text's style without restyling a layer, deselect first (Esc).
    After a committed change on the font list, size field or colour picker, the control
    gives up focus so Ctrl+Z, Delete, Esc and Ctrl+V work at once (typing in the size field
    is not intercepted).
  - Text is laid out and rasterised in Rust (left-aligned lines, the font's own line
    spacing, kerning). Since SPM-20 (owner decision 2026-11-22, superseding the
    2026-11-21 leave-as-is call) a character the chosen font lacks is no longer lost: it
    falls back per character — the fixed preference list first (Segoe UI, Arial, Microsoft
    YaHei, Yu Gothic, and the usual Linux faces), then any installed font whose cmap
    covers it — drawn at the same font size on the chosen font's line metrics; only a
    character no installed font covers draws the chosen font's tofu. An
    emoji-presentation character (or any character followed by VS16) draws IN COLOUR from
    the emoji style's font chain (the §5 setting), never as a monochrome outline — a
    chain font that only outlines it is skipped — while plain digits and other
    text-presentation characters never leave the text font. Emoji runs (ZWJ sequences,
    flags, keycaps) apply the emoji font's own plain GSUB ligatures; there is still no
    general shaping (SPM-9's line, now explicit), and a joiner nothing consumes draws
    nothing. Limits (owner decision 2026-11-24): a custom emoji font the Rust parser
    cannot colour-paint (woff2, or CBDT/sbix/SVG-emoji bytes) still renders in the DOM
    but the canvas falls back to the bundled Noto; woff2 decoding and bitmap blitting
    are parked for v2. Since SPM-18 an optional outline (the text controls above)
    strokes those glyph outlines BEHIND the fill — round joins, the width the
    reach beyond the ink in the layer's own px, the same reach the pixel Outline
    effect's width gives on an unscaled layer (the tool converts its document
    px on commit), so the two read as one feature — and the layer's box grows
    by the outline's width on every
    side while the glyphs stay where they were (the transform shifts; undo/redo and the
    typing overlay follow the model, so nothing jumps). Colour emoji are painted, not
    outlined, so an outline never rings them; their ink still grows the box like any
    ink. While text is typed the outline shows on the committed canvas render, not in
    the typing overlay: DOM text cannot stroke glyph outlines, the same accepted
    approximation class as the overlay's fonts. The canvas
    shows exactly that rendering, so the view, merge, Crop, the sizing tools and the save
    agree on its pixels and its box. Resizing a text layer scales it (it stays
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
  Details (SPM-10, 2026-11-22):
  - **Save…** sits at the right of the Editor toolbar, before Close; **Ctrl+S** does the
    same. While the canvas misses the constraint set it is disabled, with the reason (the
    live readout's text and the sizing tool that fixes it) as its tooltip; Ctrl+S then shows
    that reason in the message line. A save attempted while an Erase, Restore or Warp
    operation (above) is mid-press is refused with its reason in the message line instead —
    the operation's pixels reach the document only when it ends — and while the model
    download runs, the disabled Save… shows the download's progress as its tooltip, with
    Ctrl+S putting that reason in the message line (owner decision 2026-11-23).
  - The pack is chosen in the same pack picker as Send to pack (owner decision 2026-11-22): a
    field like the font picker. Clicking or typing opens the list of packs (Title, Short
    Name, sticker count, Draft/Live badge); typing filters it (Titles starting with the text
    first, then Titles or Short Names containing it); the arrow keys and Enter or a click
    pick; Esc or leaving the field keeps the current pack. **New pack…** sits beside the
    field and creates a Draft pack inline (Title → auto Short Name), which is then chosen.
    The field starts on the pack open in the Pack Manager, else the last pack saved into
    this session, else empty. When a pack is already chosen, the dialog opens with focus on
    **Save**, so Enter saves at once; otherwise in the pack field. The format starts on the
    session's last save's (PNG the first time). The PNG/WEBP choice is a **segmented
    control** (owner decision 2026-11-25, the SPM-15 pass; the reference is
    vizgpt.ai/tools/telegram-sticker-resizer's "Output format" selector): one horizontal
    rectangle split into two halves labelled **PNG** and **WEBP**, the active half tinted (a
    fill swap, not a sliding thumb), with a real two-radio group underneath carrying the
    keyboard and screen-reader behaviour.
  - **Saving an edited sticker** (owner decision 2026-11-22): a session opened with the Pack
    Manager's Edit remembers that sticker. Its save dialog starts with two options at the
    top: **Replace #N in <pack>** (the default; N and the pack as they are now, even after
    a reorder or rename) and **Save as a new sticker**, which shows the pack picker. A
    session opened from an image file with no slot as its origin shows only the pack picker.
    Ctrl+S then Enter replaces. A replace keeps the sticker's position and Emoji String; the
    format starts on the sticker's own, and a PNG↔WEBP change changes the file's extension
    (`002.png` → `002.webp`, ADR-0003, through the crash-safe renames of ADR-0004). The over-cap flow
    below applies the same way. If the sticker no longer exists (deleted, sent away with
    Move, or the Library changed), the dialog says so, disables Replace and selects Save as
    a new sticker: a save never writes to another slot. After a replace the note says
    "Replaced #N in “<pack>”", the unsaved-changes flag clears and the Pack Manager shows
    the new picture. After any save the session edits the saved sticker, so the next save
    offers to replace it, a new sticker included. Thumbnail-mode sessions come with SPM-12.
  - A save as a new sticker appends it at the pack's end with an order-encoded file name
    (ADR-0003) and the session's Emoji String — the one typed in the Emoji tab, held staged
    until that save; with none typed the string is empty and the sticker is flagged in the
    Pack Manager, like bulk imports (§Layout; the save dialog's hint follows the same
    value). The Library core checks the file as a sticker once more before it enters the
    pack.
  - After a save the dialog closes, the unsaved-changes flag clears, the session stays open,
    and a neutral note follows: for a new sticker it names the file, its position, the pack
    and the file size (a replace's note is above). A Pack Manager showing that pack re-reads
    it when its tab is shown again. The note ends with a **Show in Pack Manager** link (a
    button styled as a link, named after the sticker; owner decision 2026-11-22): it
    switches to the Pack Manager, opens that pack, selects the sticker alone (detail
    panel) and scrolls it into view, leaving Reorder mode if it was on; the Editor session
    stays as it is. If the sticker no longer exists (deleted, moved, or saved into the
    Library used before a Library change), the message line says so instead and nothing
    else happens.
  - PNG is encoded once at the best lossless compression: it has no quality knob. WEBP is
    lossless when that fits the cap, otherwise lossy at the highest quality that fits (alpha
    stays lossless); the quality is found automatically, there is no quality slider.
  - **Over the size cap** (owner decision 2026-11-21): a PNG over the cap says so (its size
    and the limit) in the shared dialog, **Save as WEBP** / **Cancel** (Cancel, the default,
    returns to the save dialog with "Not saved: …"). If even WEBP at its lowest quality is
    over the cap, nothing is saved: the save dialog closes and the shared dialog says, in
    the owner's words (owner decision 2026-11-22): "Congratulations, you've somehow managed
    to make an image so weird that even WEBP at its lowest quality won't save below
    {limit}. Go back to the editor and try to fix it, or fuck it all and start over. Up to
    you." ({limit} is the active constraint set's size cap, e.g. 512 KB.) **Maybe I can fix
    it**, the default, returns to the Editor; **Nah fuck it** (red) closes the session at
    once, without the unsaved-changes question: the button is the discard choice. Unlike
    the other two-option dialogs (§2: action first), this one puts **Maybe I can fix it**
    first (owner decision 2026-11-22).
  - Dev-only test hook (owner approved 2026-11-22): in a debug build (`bun run tauri dev`),
    the environment variable `SPM_DEBUG_SAVE_CAP_KB` set to a whole number of KB (at least
    1) replaces the size cap the Rust save holds the file to, for PNG and the WEBP quality
    search alike, so the "even WEBP" dialog can be reached by hand; it then names that cap.
    Other values are ignored with a warning on stderr. Release builds compile it out; the
    Editor's readout and Save blocking always use the real limits.
- **Saving is blocked unless constraints are met** — no warn-and-proceed path:
  - Sticker mode: longest side exactly **512 px** and file ≤ **512 KB**.
  - Thumbnail mode: exactly **100×100 px** and file ≤ **128 KB**, PNG/WEBP.
  - Both halves are checked in Rust on what is actually written: the flattened size, then
    the encoded bytes (KB = 1024 bytes). Saving a thumbnail (Thumbnail mode's target, the
    pack's thumbnail slot) comes with Thumbnail mode (SPM-12); the Rust checks already
    cover the thumbnail constraint set.
- The live readout shows how far the canvas is off the constraint set. **Fit in 512** and
  **Cover 512** fix it in one click in both modes; **Long side 512** also does in Sticker mode.
- In Thumbnail mode **Long side 100** is greyed out (visible but disabled, with the reason in
  its tooltip: a thumbnail must be exactly 100×100, so use Fit in 100), so the top row, the
  panels and the status strip keep identical geometry in both modes (owner decision
  2026-11-20; geometry line 2026-11-25). The one exception is the Emoji tab, hidden in
  Thumbnail mode (§Layout).
- Closing the editor with unsaved changes warns first. Unfinished, non-conforming work
  cannot be parked — there is deliberately no scratch/draft save location. Closing a CLEAN
  session whose origin sticker no longer exists (deleted, sent away with Move, or the
  Library changed) also asks first — "Sticker no longer exists", **Close anyway** /
  **Keep editing** (Keep editing the default), because closing would discard the only
  remaining copy (owner decision 2026-11-23); the save dialog's Replace option decides
  with the same existence check, opening another image from the Pack Manager asks the
  same, and a session without an origin (a plain file) never warns.
- Thumbnail mode is the same editor with a canvas that starts at 100×100 (instead of
  512×512) and the thumbnail constraint set. Sizing tools 1, 2 and 4 take their side from
  the active constraint set: in Thumbnail mode they are **Fit in 100**, **Cover 100** and
  **Long side 100** (greyed out, see above) (owner decision 2026-11-20); free resize is the
  same in both modes.

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
- DB reconstruction from orphaned files.
- Project files / version history; export/prep folders; scratch saves.

## 9. Deferred decisions

- **UX**: decided — see the §5 command map (SPM-4, 2026-11-19).
- **Engineering (each gets an ADR at implementation time)**: ONNX runtime placement
  (Rust vs webview) — ADR-0006 (SPM-7, accepted; owner decisions built in): Rust `ort`
  with ISNet; canvas library choice — decided, see ADR-0005 (SPM-5: Konva in the webview
  for interaction, Rust crates for one-shot pixel work and encoding); crash-safe rename
  mechanics — decided, see ADR-0004 (SPM-2).
- Small UX defaults assumed unless preferences emerge: system fonts + size/color for text;
  color/width for outline; color/radius/softness for glow; strength/radius for warp.

### Ignored edge cases
Known rough edges the owner has looked at and chosen not to fix for now (each with its date).
- Editor, Lasso: drawing a freehand stroke while panning with the middle button at the same
  time can give a messy outline, because the view lags the pointer slightly during the pan
  (owner, 2026-11-22: rare combination, not worth fixing now).

### v2 parking lot (UX)
- Emoji font library: the app keeps its own `fonts/` folder (inside the app-config
  directory), copies a picked custom emoji font into it, and lists the copies as regular
  entries in the Settings Emoji font dropdown (add/remove, pick-once-reuse-forever) — the
  app's copy survives whatever happens to the original file, and the broken-font-at-boot
  fallback becomes near-impossible to hit. Parked to keep v1's scope (owner, 2026-11-24:
  raised during the SPM-17 Windows test; inverting SPM-17's store-the-path-not-a-copy
  decision is the point). The owner expects much of the v2 list to slip to v3.
- Emoji `.ttc` font files: Chromium's FontFace refuses whole TTC collections, but the
  app's Rust read could unwrap the container (tiny `ttcf` header parse) and hand the
  webview the emoji member (match "Emoji" in the name table, else the first) before the
  engine sees the bytes — small, pure, testable; the inner font still must pass the engine
  (parked next to the library idea, owner, 2026-11-24; the picker filter and the read
  guard would gain `.ttc`).
- Double-click shortcuts (e.g. double-click a sticker to open the Editor).
- Right-click context menu mirroring the detail panel's commands.
- Click-and-hold a sticker to activate Reorder mode.
- Group-drag reorder (moving several stickers at once).
- Trash/recovery area for deleted stickers.
- Bulk emoji-set: rejected as unnecessary — not planned.
- Editor: every edge of the selection box is grabbable for resizing, not just the corners.
- Editor: custom canvas resizing (in v1 only Fit in, Cover and Long side change the canvas).
- Drag and drop an image file to open it in the Editor.
- Editor: Crop could also drop a layer that crosses the box edge when its part inside the
  box is fully transparent. In v1 such a layer is kept; only layers entirely outside the box
  are discarded (owner, 2026-11-21: may revisit).
- Editor: a manual text-to-image conversion button, so a text layer can be edited with pixel
  tools (e.g. Cut) without merging it onto another layer first (owner, 2026-11-21). When it is
  built it lives in the Text category, not the action grid — its subject is one text layer,
  like Edit text; it changes neither the stack count nor the layer order, and it mirrors the
  effects' Apply commit; the Rust rasterisation machinery already exists through Glow on text
  and a Crop crossing a text layer (owner, 2026-11-25).
- Editor: real clipboard for Cut/Copy: Ctrl+C copies the selected pixels (or the selected
  layer) to the system clipboard as PNG, Ctrl+X does the same and leaves a transparent
  hole, so stickers can be copied between sessions and apps (owner, 2026-11-21).
- Editor: hold Shift while moving a layer to snap to whole pixels or to a grid. Note:
  Shift+click already toggles a layer in or out of the selection, so a Shift-drag must
  not also toggle it; and the Editor has no grid yet (owner, 2026-11-21).
- Pack Manager: a button next to the Emoji String field that opens an emoji picker for easy
  selection (owner, 2026-11-21).
- Editor: layer locking, so a locked layer cannot be selected, moved or edited by accident
  (owner, 2026-11-22).
- Editor save dialog: an Emoji String field, so a new sticker gets its emoji as it is saved
  (owner, 2026-11-22; in v1 it is saved without emoji and flagged in the Pack Manager).
- Settings: Editor defaults (the tool settings a session starts with) configurable in the
  Settings tab. In v1 Editor settings last only until the app closes and always start from
  the defaults (owner, 2026-11-22).
- Editor: mirror a layer along its vertical axis (flip it left ↔ right); its horizontal
  axis too (flip top ↔ bottom) if that is cheap and easy once the first one is built
  (owner, 2026-11-23).
- Editor: remove a layer's excess transparency — crop the layer to its visible content,
  the "crop to content" function of other graphics editors (owner, 2026-11-23).

### v3 parking lot
- Drag and drop an image file onto an open session to add it as a layer (owner, 2026-11-20).
- Pack Manager: in Reorder mode the sticker images wiggle (as on phone home screens),
  instead of or as well as the green tint (owner, 2026-11-21: animations are a bigger job).
- Editor, warp: hold Alt to pinch (shrink) instead of bulge (owner, 2026-11-22).
- Editor: a screen-wide colour sampler for the eyedropper, beyond the canvas. Needs Rust
  screen capture: capture, DPI, multi-monitor, an overlay window (owner, 2026-11-23).
- Editor: speech bubbles, e.g. with Konva's Label and Tag (owner, 2026-11-22).
- Editor: arrows and shapes (owner, 2026-11-22).
- Editor: text along a curve, e.g. with Konva's TextPath (owner, 2026-11-22).
- Editor: colour filters (owner, 2026-11-22).

### v4 parking lot
- Editor: a "deep fry" tool: colour filters, grain, noise and the like in one go (owner,
  2026-11-22).

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
6. **Crop & sizing**: box overlay, destructive crop, four sizing tools, live readout.
7. **Background removal**: ONNX placement ADR, offline auto removal, refine brush.
8. **Effects**: outline, fuzzy glow, warp/bulge (layer-targeted).
9. **Cut/paste/resize + text tool**.
10. **Save pipeline**: target-pack picker, PNG/WEBP encoding, hard-block validation (both
    modes), unsaved-changes close warning.
11. **Replace and Send-to-pack flows**: validated drop-in, slot-preserving replace,
    unified Send to pack (single/bulk, two-phase atomicity, source renumbering), Missing
    replacement and Missing-slot deletion.
12. **Thumbnail mode**: 100×100 editor mode + thumbnail CRUD in pack view.

Dependency spine (wired in Trekker): 1 → 2 → 3; 5 → 6/7/8/9; 2+6+9 → 10 (save does not wait for 7/8, owner 2026-11-21); 2+10 → 11; 5+10 → 12;
4 gated the final shape of 3's per-sticker surface (resolved).

# stickerpack-maker

A local-first desktop app for making Telegram sticker packs: an **Editor** that turns images
into finished stickers, and a **Pack Manager** that organises them into packs on disk in
upload order. v1 targets Windows: Tauri v2 (Rust core + TypeScript webview) with SQLite.
No Telegram network calls in v1 — uploads are manual via @Stickers. Once installed, the
app's only network use is the one-time download of the background-removal model.

- Requirements: `docs/SPEC.md` (source of truth)
- Vocabulary: `GLOSSARY.md`
- Durable decisions: `docs/adr/` (0001 stack · 0002 independent copies · 0003 order-encoded
  filenames · 0004 crash-safe renames · 0005 editor hybrid split · 0006 background removal
  in Rust · 0007 Library upgrades on open · 0008 effect previews drawn by Rust · 0009
  selection as a floating area)
- Work items and live status: Trekker (`.trekker/trekker.db`), see `docs/agents/issue-tracker.md`

## What v1 does

- **Library** (`src-tauri/src/library/`): a first-run chooser (suggesting
  `Documents\Stickerpack Library`); Settings can re-point the app at another intact Library
  or create a fresh one in an empty folder. Packs and stickers live in SQLite (`library.db`),
  each Pack in a folder named after its Short Name, with order-encoded sticker files
  (`001.png`, `002.webp`, …; the Thumbnail is an unnumbered `thumbnail.png` / `.webp`) kept
  in sync by a crash-safe rename engine with journal recovery. An older Library's database
  is upgraded when the app opens it. Desync checks mark absent files Missing when a Pack is
  opened, on Refresh, and each time the Pack list is shown — never on app start.
- **Pack Manager** (`src/pack-manager/`): the Pack list (search by Title or Short Name, drag to
  reorder, each row with its thumbnail, status badge and Draft/Live badge); New pack (Title →
  auto-derived Short Name; the Title stays editable, the Short Name only while Draft); the
  Draft/Live toggle and Delete ask first. In a Pack: a sticker grid with click / Ctrl+click /
  Shift+click selection and a Reorder mode that renames the files; a detail panel per Sticker
  (Emoji String editing with a copy button, Edit in the Editor, Replace, Send to pack, Open in
  explorer, Delete); Send to pack (Duplicate or Move) and Delete for several stickers at once;
  bulk import by drag-drop or **Add images…** (valid stickers only, in natural filename order;
  rejected files the Editor can import can be opened in it); the Thumbnail slot; Missing
  stickers flagged, to replace or delete. Over 120 stickers and an Emoji String outside 1–20
  emoji warn but never block. **Upload…** opens the Upload list: every sticker in order with
  its emoji to copy, and on Windows each preview of a sticker that is not Missing drags its
  file straight into the @Stickers chat in Telegram Desktop.
- **Editor** (`src-tauri/src/editor/` + `src/editor/`): open an image (JPG, JPEG, JFIF, PNG,
  WEBP; larger than 2000×2000 asks to scale) or drop one on the Editor; add images as
  layers, also by pasting (Ctrl+V); move / scale / rotate, zoom and pan, undo/redo with a
  read-only Actions list, merge and delete layers. Sizing: **Fit in 512**, **Cover 512**,
  **Long side 512** and free resize, the 512 **Guide** box and **Crop**, and a live readout of
  the canvas against the constraints. Rectangle, Lasso and Wand selections to Cut or Delete.
  Remove background (ISNet on ONNX Runtime in Rust: the 179 MB model downloads once on first
  use, checked against a pinned SHA-256, then runs offline) with an Erase / Restore brush;
  Warp (bulge); Outline and Glow with a live preview; text layers (system fonts, size,
  colour, outline; emoji drawn in colour); an eyedropper beside every colour picker.
  Thumbnail mode edits a Pack's 100×100 Thumbnail. **Save…** flattens to PNG or WEBP into a
  Pack, as a new sticker or replacing the one being edited, and is blocked unless the result
  meets the sticker constraints (`docs/SPEC.md` §7): longest side exactly 512 px and at most
  512 KB for a sticker, exactly 100×100 px and at most 128 KB for a thumbnail.
- **Settings**: the Library path, the theme (follow system, light or dark), the Emoji Style
  (the emoji font: bundled Noto Color Emoji by default, bundled Twemoji, the system's Segoe UI
  Emoji, or a custom font file), and Credits with **Open licence texts**.

Not in v1 (SPEC §8): Bot API sync, animated or video stickers, custom emoji packs,
rebuilding a Library's metadata from orphaned image files, project files or version history,
export/prep folders, and scratch saves.

## Development (Linux / WSL)

Day-to-day development, tests, and the dev app run on Linux — in practice Ubuntu under WSL2,
where WSLg shows the app window. Needed on the machine:

- **Bun** (package manager and TS test runner) and **Node.js** (Tauri's dev/build hooks
  call `node node_modules/...` directly)
- **Rust** via [rustup](https://rustup.rs/) (stable)
- Tauri's Linux system packages, notably WebKitGTK 4.1 — see Tauri's
  [Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux)

```bash
bun install                                   # once
bun test                                      # TS tests (model, view logic, IPC wiring, migrations)
bun run build                                 # typecheck (tsc --noEmit) + frontend build -> dist/
cargo test --manifest-path src-tauri/Cargo.toml --lib    # Rust tests
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
bun run tauri dev                             # the desktop app
bun run icons                                 # regenerate src-tauri/icons
bun run licenses                              # regenerate src-tauri/licenses/THIRD-PARTY-NOTICES.txt
```

The first Rust build fetches the crates, compiles SQLite from source and libwebp from
vendored C, and downloads a prebuilt ONNX Runtime (`ort`'s `download-binaries`), so it needs
the network.

Under WSLg, `libEGL` / `MESA ... ZINK` warnings at launch are harmless: the app runs
normally. Dragging files out of the Upload list is Windows-only; on Linux the drag does
nothing.

## Windows release build

The v1 deliverable is a Windows NSIS installer, built on Windows with:

1. **Rust** via rustup, with the MSVC toolchain as the default host triple
2. **Microsoft C++ Build Tools** with the *Desktop development with C++* option
3. **WebView2 runtime** (already installed on Windows 10 from version 1803, and later)
4. **Bun** and **Node.js**, as for development

Items 1–3 are Tauri's
[Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows).

```powershell
bun install
bun run tauri build    # -> src-tauri/target/release/bundle/nsis/
```

### Install and uninstall

The installer is per-user: it installs to `%LOCALAPPDATA%\Stickerpack Maker` and needs no
administrator rights. `LICENSE.txt` and `THIRD-PARTY-NOTICES.txt` are installed next to the
exe (Settings, Credits, "Open licence texts" opens the latter).

Uninstalling never touches your Library (by default `Documents\Stickerpack Library`). The
uninstaller's "delete application data" box is unchecked by default; when ticked it removes
`%APPDATA%\com.stickerpackmaker.desktop` and `%LOCALAPPDATA%\com.stickerpackmaker.desktop`
(the downloaded background-removal model and the app settings). A Library deliberately placed
inside one of those folders would be deleted with them.

## Licence

Stickerpack Maker is released under the [MIT License](LICENSE). Its third-party components
(every Rust crate the Windows app links, ONNX Runtime, the bundled npm packages and emoji
fonts, and the downloaded ISNet model) are listed with their licence texts in
[`src-tauri/licenses/THIRD-PARTY-NOTICES.txt`](src-tauri/licenses/THIRD-PARTY-NOTICES.txt),
generated by `bun run licenses`. Regenerate and commit it whenever the Rust or npm
dependencies change. It needs [`cargo-about`](https://github.com/EmbarkStudios/cargo-about)
(`cargo install --locked --features cli cargo-about`, per its
[README](https://github.com/EmbarkStudios/cargo-about)) and runs offline once `bun install`
and `cargo fetch --manifest-path src-tauri/Cargo.toml` (which fetches every target's crates,
not only the current platform's) have fetched the dependencies; ONNX Runtime's and ISNet's
texts are vendored in `src-tauri/licenses/vendor/` (see its README).

## Layout

- `src-tauri/` — Rust core (Tauri-free modules are unit-tested; the command files wrap them)
  - `src/library/` — the Library: `schema` (rows), `packs` (create/edit/delete, Short Name
    folders, Thumbnail), `files` (order-encoded names, rename engine + journal recovery),
    `stickers` (add/reorder/delete/replace, Send to pack, warnings), `desync` (open a pack,
    mark Missing)
  - `src/editor/` — Editor pixel work: `import` (decode, EXIF orientation, 2000 cap),
    `merge`, `crop`, `cut`, `wand` and `compose` (selections), `effects` (outline, glow),
    `text` and `emoji` (text layers), `save` and `encode` (flatten, PNG/WEBP under the cap)
  - `src/ml/` — background removal: the model's pinned facts, its one-time verified
    download, and the ONNX Runtime session
  - `src/config.rs` — machine-local app config (Library path, emoji font), in the OS
    app-config dir, **not** inside the Library
  - `src/db.rs` — SQLite + migrations runner; `migrations/` — ordered SQL, never edited once
    shipped
  - `src/limits.rs` — every limit in the repo-root `src/shared/limits.json`, as constants
    `build.rs` generates
  - `src/commands.rs` (app, Settings, Editor), `pack_commands.rs` (Pack Manager),
    `save_commands.rs` (Editor save), `drag_commands.rs` (Upload list drag-out) — Tauri
    commands exposed to the webview
  - `licenses/` — `THIRD-PARTY-NOTICES.txt` and the vendored licence texts
- `src/` — webview UI (vanilla TS, no framework; Konva for the Editor's canvas only)
  - `main.ts` boot/first-run routing · `shell.ts` top bar and navigation · `api.ts` typed
    invoke wrappers
  - `views/` — editor, pack-manager, settings, first-run
  - `editor/` — Editor internals: `api.ts` (commands + binary frames), `model/` (document,
    history, session, tools), `view/` (Konva stage, pure view logic), `editor.css`
  - `pack-manager/` — Pack Manager internals: `api.ts`, `model/` (selection, modes, pack
    issues, Upload list), `view/` (pack list, pack view, panels, dialogs)
  - `shared/` — code both screens use, and `limits.json`, the one definition of the limits
- `public/fonts/` — the bundled emoji fonts (Noto Color Emoji, Twemoji) and their licences
- `tests/` — bun tests
- `scripts/` — `generate-icons.mjs` (dependency-free icon generator), `licenses.mjs`
  (`bun run licenses`), `generate-emoji-presentation.mjs` (`src-tauri/src/editor/emoji_data.rs`
  from Unicode's `emoji-data.txt`)

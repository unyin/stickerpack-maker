# stickerpack-maker

A local-first desktop app for making Telegram sticker packs: an **Editor** that turns images
into finished stickers, and a **Pack Manager** that organises them into packs on disk in
upload order. v1 targets Windows: Tauri v2 (Rust core + TypeScript webview) with SQLite.
No Telegram network calls in v1 — uploads are manual via @Stickers.

- Requirements: `docs/SPEC.md` (source of truth)
- Vocabulary: `GLOSSARY.md`
- Durable decisions: `docs/adr/` (0001 stack · 0002 independent copies · 0003 order-encoded
  filenames · 0004 crash-safe renames · 0005 editor hybrid split)
- Work items and live status: Trekker (`.trekker/trekker.db`), see `docs/agents/issue-tracker.md`

## What exists

- **Library** (`src-tauri/src/library/`): first-run chooser, re-pointing, packs and stickers
  in SQLite, pack folders named after the Short Name, order-encoded sticker files
  (`001.png`, `002.webp`, …) kept in sync by a crash-safe rename engine, Send to pack,
  and desync detection (Missing) on pack open. No Pack Manager UI yet.
- **Editor** (`src-tauri/src/editor/` + `src/editor/`): open an image (JPG, JPEG, JFIF,
  PNG, WEBP; larger than 2000×2000 asks to scale), add images as layers, move / scale /
  rotate, zoom and pan, undo/redo, merge selected layers. Crop, background removal,
  effects, text and saving are still to come.

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
bun run tauri dev                             # the desktop app (first run compiles SQLite)
bun run icons                                 # regenerate src-tauri/icons
```

Under WSLg, `libEGL` / `MESA ... ZINK` warnings at launch are expected: WebKitGTK falls
back to software rendering, and the app runs normally.

## Windows release build

The v1 deliverable is a Windows NSIS installer, built on Windows with:

1. **Rust (MSVC toolchain)** via rustup — `stable-x86_64-pc-windows-msvc`
2. **VS Build Tools 2022** with the *Desktop development with C++* workload
3. **WebView2 runtime** (preinstalled on Windows 11)

```powershell
bun install
bun run tauri build    # -> src-tauri/target/release/bundle/nsis/
```

The Windows build has not been exercised since development moved to WSL; the Editor's
binary IPC (raw image bytes between the webview and Rust) in particular still needs a
first check inside WebView2.

## Layout

- `src-tauri/` — Rust core (Tauri-free modules are unit-tested; `commands.rs` wraps them)
  - `src/library/` — the Library: `schema` (rows), `packs` (create/edit/delete, Short Name
    folders), `files` (order-encoded names, rename engine + journal recovery), `stickers`
    (add/reorder/delete/replace, Send to pack, warnings), `desync` (open a pack, mark Missing)
  - `src/editor/` — Editor pixel work: `import` (decode, EXIF orientation, 2000 cap),
    `merge` (composite layers)
  - `src/config.rs` — machine-local app config (Library path), in the OS app-config dir,
    **not** inside the Library
  - `src/db.rs` — SQLite + migrations runner; `migrations/` — ordered SQL, never edited once
    shipped
  - `src/commands.rs` — Tauri commands exposed to the webview
- `src/` — webview UI (vanilla TS, no framework)
  - `main.ts` boot/first-run routing · `shell.ts` navigation · `api.ts` typed invoke wrappers
  - `views/` — editor, pack-manager, settings, first-run
  - `editor/` — Editor internals: `api.ts` (commands + binary frames), `model/` (document,
    history, session), `view/` (Konva stage, pure view logic), `editor.css`
- `tests/` — bun tests
- `scripts/generate-icons.mjs` — dependency-free icon generator

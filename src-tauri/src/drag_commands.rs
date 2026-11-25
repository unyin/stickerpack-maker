//! Drag-out (SPM-21, owner decision 2026-11-25): the Upload list's sticker
//! previews start a native OS file drag, so a sticker file can be dropped
//! straight into the @Stickers chat in Telegram Desktop.
//!
//! The webview passes only a sticker id (or a pack id for the thumbnail);
//! the path is resolved here exactly like `reveal_sticker` /
//! `reveal_thumbnail` do, so the webview can never name an arbitrary file to
//! drag. The CrabNebula `drag` crate is wrapped by these two commands rather
//! than exposed through a plugin permission, for that reason.
//!
//! Windows only (the v1 target): `drag` runs OLE `DoDragDrop` with a
//! `CF_HDROP` file list. Elsewhere the commands resolve the path and do
//! nothing (see `start_native_drag`).

use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::ImageFormat;
use tauri::{State, WebviewWindow};

use crate::library::desync;
use crate::pack_commands::{with_library, LibraryLock};
use crate::SharedConfig;

/// The drag preview's longest side in px: the cursor image, not the file.
const PREVIEW_SIDE: u32 = 96;

/// A small PNG of the sticker for the drag cursor, or empty when the file
/// cannot be decoded (the drag then runs without a preview image).
///
/// Always PNG, always small: the `drag` crate decodes the preview with the
/// Windows imaging component, which reads PNG everywhere but WEBP only when
/// the optional "WebP Image Extensions" are installed; and a 512 px
/// bitmap is far too big for a cursor image. The app decodes with its own
/// `image` crate (PNG, JPEG and WEBP) instead.
#[cfg_attr(not(windows), allow(dead_code))] // only the Windows drag uses it (and the tests)
fn drag_preview_png(path: &Path) -> Vec<u8> {
    let Ok(img) = image::open(path) else { return Vec::new() };
    let mut out = Cursor::new(Vec::new());
    match img.thumbnail(PREVIEW_SIDE, PREVIEW_SIDE).write_to(&mut out, ImageFormat::Png) {
        Ok(()) => out.into_inner(),
        Err(_) => Vec::new(),
    }
}

/// Start the native drag of `path`. Blocks until the drag ends (dropped or
/// cancelled), like OLE's `DoDragDrop`, so the pointer stays with the OS for
/// the whole gesture; the command runs off the UI thread, and the drag itself
/// is handed to it because OLE drag-and-drop must run on the thread that owns
/// the window (the main thread; `tauri-plugin-drag` does the same).
#[cfg(windows)]
fn start_native_drag(window: &WebviewWindow, path: PathBuf) -> Result<(), String> {
    let preview = drag_preview_png(&path);
    let (tx, rx) = std::sync::mpsc::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let result = drag::start_drag(
                &target,
                drag::DragItem::Files(vec![path]),
                drag::Image::Raw(preview),
                |_result, _cursor| {},
                drag::Options::default(),
            )
            .map_err(|e| format!("cannot start the drag: {e}"));
            let _ = tx.send(result);
        })
        .map_err(|e| format!("cannot start the drag: {e}"))?;
    rx.recv().map_err(|e| format!("the drag ended unexpectedly: {e}"))?
}

/// Not Windows: a no-op. The `drag` crate's Linux (GTK) path needs a live GTK
/// drag gesture that the webview's own event handling owns, and macOS is not a
/// v1 target (SPEC §2), so neither is wired; the dev build on Linux still runs
/// the Upload list, its previews simply do not drag out.
#[cfg(not(windows))]
fn start_native_drag(_window: &WebviewWindow, _path: PathBuf) -> Result<(), String> {
    Ok(())
}

/// Drag a sticker's file out of the app (Upload list).
#[tauri::command(async)]
pub fn drag_sticker(
    sticker_id: i64,
    window: WebviewWindow,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<(), String> {
    // The Library lock is released before the drag starts: the drag blocks
    // until the user drops, and must not hold up every other command.
    let path = with_library(&config, &lock, |conn, dir| desync::sticker_file_path(conn, dir, sticker_id))?;
    start_native_drag(&window, path)
}

/// Drag the pack's thumbnail file out of the app (Upload list).
#[tauri::command(async)]
pub fn drag_thumbnail(
    pack_id: i64,
    window: WebviewWindow,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<(), String> {
    let path = with_library(&config, &lock, |conn, dir| desync::thumbnail_file_path(conn, dir, pack_id))?;
    start_native_drag(&window, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::test_images::{png_sized, webp_sized};

    fn decode(png: &[u8]) -> image::DynamicImage {
        image::load_from_memory_with_format(png, ImageFormat::Png).unwrap()
    }

    #[test]
    fn preview_of_a_png_is_a_small_png() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("001.png");
        std::fs::write(&file, png_sized(512, 300, "x")).unwrap();
        let img = decode(&drag_preview_png(&file));
        assert_eq!((img.width(), img.height()), (PREVIEW_SIDE, 56));
    }

    #[test]
    fn preview_of_a_webp_is_a_png() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("002.webp");
        std::fs::write(&file, webp_sized(512, 512, "x")).unwrap();
        let img = decode(&drag_preview_png(&file));
        assert_eq!((img.width(), img.height()), (PREVIEW_SIDE, PREVIEW_SIDE));
    }

    #[test]
    fn preview_of_an_unreadable_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let junk = dir.path().join("003.png");
        std::fs::write(&junk, b"not an image").unwrap();
        assert!(drag_preview_png(&junk).is_empty());
        assert!(drag_preview_png(&dir.path().join("absent.png")).is_empty());
    }
}

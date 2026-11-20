//! Pack Manager commands (SPEC §5, SPM-3): thin Tauri wrappers over the
//! Library core (`crate::library`). The typed TS wrappers live in
//! `src/pack-manager/api.ts`; command names and camelCase fields must stay
//! in sync.
//!
//! Every command runs under one `LibraryLock`, so Library operations never
//! run concurrently (ADR-0004: the core assumes per-pack serialized calls).
//! Each opens its own connection to the configured Library.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::library::desync::{self, PackView};
use crate::library::packs::{self, LeftoverFolder, PackSummary};
use crate::library::schema::{Pack, PackStatus, Sticker};
use crate::library::stickers::{self, FileError, NewSticker, SendFailure, SendReport};
use crate::{library, SharedConfig};

/// Serializes Library operations across command threads.
#[derive(Default)]
pub struct LibraryLock(Mutex<()>);

/// The configured Library folder, or why there is none.
fn library_dir(config: &State<'_, SharedConfig>) -> Result<PathBuf, String> {
    let guard = config.config.lock().map_err(|_| "app config lock poisoned".to_string())?;
    guard
        .library_path
        .clone()
        .ok_or_else(|| "no Library is configured; choose one in Settings".to_string())
}

/// Run `op` on the configured Library under the Library lock.
fn with_library<T>(
    config: &State<'_, SharedConfig>,
    lock: &State<'_, LibraryLock>,
    op: impl FnOnce(&mut Connection, &Path) -> Result<T, String>,
) -> Result<T, String> {
    let dir = library_dir(config)?;
    let _serial = lock.0.lock().map_err(|_| "library lock poisoned".to_string())?;
    let mut conn = library::open(&dir)?;
    op(&mut conn, &dir)
}

/// Result of a bulk import (SPEC §5): the refreshed pack, the new stickers'
/// ids in drop order, and the files rejected with their reasons.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub view: PackView,
    pub added_ids: Vec<i64>,
    pub rejected: Vec<FileError>,
}

/// Bulk import: every file is checked like a drop-in; the valid ones are
/// appended in the given (drop) order with an empty Emoji String, the
/// invalid ones rejected per file (SPEC §5).
pub fn import_files(conn: &mut Connection, dir: &Path, pack_id: i64, paths: &[String]) -> Result<ImportResult, String> {
    let new: Vec<NewSticker> = paths
        .iter()
        .map(|p| NewSticker { path: PathBuf::from(p), emoji_string: String::new() })
        .collect();
    let outcome = stickers::add_stickers(conn, dir, pack_id, &new, None)?;
    Ok(ImportResult {
        view: desync::open_pack(conn, dir, pack_id)?,
        added_ids: outcome.added.iter().map(|s| s.id).collect(),
        rejected: outcome.rejected,
    })
}

/// Reorder mode's one-sticker move, then the refreshed pack (SPEC §5).
pub fn reorder(conn: &mut Connection, dir: &Path, sticker_id: i64, new_position: i64) -> Result<PackView, String> {
    let pack_id = stickers::reorder_sticker(conn, dir, sticker_id, new_position)?
        .first()
        .map(|s| s.pack_id)
        .ok_or_else(|| "internal error: reordered pack is empty".to_string())?;
    desync::open_pack(conn, dir, pack_id)
}

/// The pack of `sticker_id`.
fn pack_of(conn: &Connection, sticker_id: i64) -> Result<i64, String> {
    Ok(library::schema::load_sticker(conn, sticker_id)?.pack_id)
}

// ---- Pack list ----

#[tauri::command(async)]
pub fn list_packs(config: State<'_, SharedConfig>, lock: State<'_, LibraryLock>) -> Result<Vec<PackSummary>, String> {
    with_library(&config, &lock, |conn, _| packs::pack_summaries(conn))
}

/// Live preview for the create dialog: the Short Name a Title derives.
#[tauri::command(async)]
pub fn suggest_short_name(
    title: String,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<String, String> {
    with_library(&config, &lock, |conn, dir| packs::suggest_short_name(conn, dir, &title))
}

/// Create a Draft pack. `short_name` None = auto-derive (made unique);
/// Some = the user's edit, validated and refused when taken.
#[tauri::command(async)]
pub fn create_pack(
    title: String,
    short_name: Option<String>,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<Pack, String> {
    with_library(&config, &lock, |conn, dir| packs::create_pack(conn, dir, &title, short_name.as_deref()))
}

/// Delete a pack and its local folder (Draft or Live; the UI confirms).
#[tauri::command(async)]
pub fn delete_pack(
    pack_id: i64,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<Option<LeftoverFolder>, String> {
    with_library(&config, &lock, |conn, dir| packs::delete_pack(conn, dir, pack_id))
}

// ---- Pack view ----

/// Open or manually refresh a pack: recovery, then desync detection
/// (SPEC §4: pack open and refresh only, never app start).
#[tauri::command(async)]
pub fn open_pack(pack_id: i64, config: State<'_, SharedConfig>, lock: State<'_, LibraryLock>) -> Result<PackView, String> {
    with_library(&config, &lock, |conn, dir| desync::open_pack(conn, dir, pack_id))
}

#[tauri::command(async)]
pub fn set_pack_title(
    pack_id: i64,
    title: String,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<Pack, String> {
    with_library(&config, &lock, |conn, _| packs::set_title(conn, pack_id, &title))
}

/// Draft only; the core refuses it while Live (SPEC §3).
#[tauri::command(async)]
pub fn set_pack_short_name(
    pack_id: i64,
    short_name: String,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<Pack, String> {
    with_library(&config, &lock, |conn, dir| packs::set_short_name(conn, dir, pack_id, &short_name))
}

#[tauri::command(async)]
pub fn set_pack_status(
    pack_id: i64,
    status: PackStatus,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<Pack, String> {
    with_library(&config, &lock, |conn, _| packs::set_status(conn, pack_id, status))
}

#[tauri::command(async)]
pub fn reorder_sticker(
    sticker_id: i64,
    new_position: i64,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<PackView, String> {
    with_library(&config, &lock, |conn, dir| reorder(conn, dir, sticker_id, new_position))
}

/// Delete stickers (Missing ones included) and renumber the pack.
#[tauri::command(async)]
pub fn delete_stickers(
    pack_id: i64,
    sticker_ids: Vec<i64>,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<PackView, String> {
    with_library(&config, &lock, |conn, dir| {
        stickers::delete_stickers(conn, dir, pack_id, &sticker_ids)?;
        desync::open_pack(conn, dir, pack_id)
    })
}

/// Store an Emoji String exactly as typed (warn-only, SPEC §3).
#[tauri::command(async)]
pub fn set_emoji_string(
    sticker_id: i64,
    emoji_string: String,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<Sticker, String> {
    with_library(&config, &lock, |conn, _| stickers::set_emoji_string(conn, sticker_id, &emoji_string))
}

#[tauri::command(async)]
pub fn import_stickers(
    pack_id: i64,
    paths: Vec<String>,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<ImportResult, String> {
    with_library(&config, &lock, |conn, dir| import_files(conn, dir, pack_id, &paths))
}

/// The drop-in check alone (PNG/WEBP, one side exactly 512 px, ≤512 KB),
/// so the UI can hard-block a bad file with "open in editor / cancel".
#[tauri::command(async)]
pub fn check_sticker_file(path: String) -> Result<(), String> {
    stickers::validate_sticker_file(Path::new(&path)).map(|_| ())
}

/// Validated drop-in replacement, keeping position and Emoji String; also
/// how a Missing sticker is fixed (SPEC §5).
#[tauri::command(async)]
pub fn replace_sticker(
    sticker_id: i64,
    path: String,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<PackView, String> {
    with_library(&config, &lock, |conn, dir| {
        let pack_id = pack_of(conn, sticker_id)?;
        stickers::replace_sticker_file(conn, dir, sticker_id, Path::new(&path))?;
        desync::open_pack(conn, dir, pack_id)
    })
}

/// Send to pack (SPEC §5): the two-phase Duplicate/Move in the core.
#[tauri::command(async)]
pub fn send_to_pack(
    sticker_ids: Vec<i64>,
    target_pack_id: i64,
    delete_originals: bool,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<SendReport, SendFailure> {
    let dir = library_dir(&config)?;
    let _serial = lock.0.lock().map_err(|_| "library lock poisoned".to_string())?;
    let mut conn = library::open(&dir)?;
    stickers::send_to_pack(&mut conn, &dir, &sticker_ids, target_pack_id, delete_originals)
}

// ---- Files ----

/// A sticker file's full path, for Edit (opens it in the Editor).
#[tauri::command(async)]
pub fn sticker_file_path(sticker_id: i64, config: State<'_, SharedConfig>, lock: State<'_, LibraryLock>) -> Result<String, String> {
    with_library(&config, &lock, |conn, dir| desync::sticker_file_path(conn, dir, sticker_id))
        .map(|p| p.to_string_lossy().into_owned())
}

/// Open the pack folder in the file explorer with the file selected
/// (SPEC §4). tauri-plugin-opener's `reveal_item_in_dir` uses the shell's
/// select-item API on Windows (Explorer opens the folder, file selected)
/// and the platform equivalent elsewhere. Called from Rust with a path the
/// core resolves, so the webview gets no general reveal permission.
fn reveal(path: PathBuf) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| format!("cannot show {} in the file explorer: {e}", path.display()))
}

#[tauri::command(async)]
pub fn reveal_sticker(sticker_id: i64, config: State<'_, SharedConfig>, lock: State<'_, LibraryLock>) -> Result<(), String> {
    reveal(with_library(&config, &lock, |conn, dir| desync::sticker_file_path(conn, dir, sticker_id))?)
}

#[tauri::command(async)]
pub fn reveal_thumbnail(pack_id: i64, config: State<'_, SharedConfig>, lock: State<'_, LibraryLock>) -> Result<(), String> {
    reveal(with_library(&config, &lock, |conn, dir| desync::thumbnail_file_path(conn, dir, pack_id))?)
}

fn read_bytes(path: &Path) -> Result<tauri::ipc::Response, String> {
    std::fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))
}

/// A sticker's file bytes (raw, never JSON) for the pack view's previews.
#[tauri::command(async)]
pub fn sticker_image(
    sticker_id: i64,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<tauri::ipc::Response, String> {
    read_bytes(&with_library(&config, &lock, |conn, dir| desync::sticker_file_path(conn, dir, sticker_id))?)
}

/// The thumbnail's file bytes for the thumbnail slot's preview.
#[tauri::command(async)]
pub fn thumbnail_image(
    pack_id: i64,
    config: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<tauri::ipc::Response, String> {
    read_bytes(&with_library(&config, &lock, |conn, dir| desync::thumbnail_file_path(conn, dir, pack_id))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::packs::create_pack;
    use crate::library::schema::load_stickers;
    use crate::limits::STICKER_SIDE;
    use std::fs;

    fn png(width: u32, height: u32, tag: &str) -> Vec<u8> {
        crate::library::test_images::png_sized(width, height, tag)
    }

    struct Lib {
        dir: tempfile::TempDir,
        sources: tempfile::TempDir,
        conn: Connection,
    }

    impl Lib {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            library::create_fresh(dir.path()).unwrap();
            let conn = library::open(dir.path()).unwrap();
            Lib { dir, sources: tempfile::tempdir().unwrap(), conn }
        }

        fn source(&self, name: &str, bytes: Vec<u8>) -> String {
            let path = self.sources.path().join(name);
            fs::write(&path, bytes).unwrap();
            path.to_string_lossy().into_owned()
        }
    }

    #[test]
    fn import_appends_valid_files_in_drop_order_without_emoji_and_rejects_the_rest() {
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "P", None).unwrap();
        let paths = [
            lib.source("b.png", png(STICKER_SIDE, 10, "B")),
            lib.source("small.png", png(10, 10, "S")),
            lib.source("a.png", png(10, STICKER_SIDE, "A")),
            lib.source("notes.txt", b"hello".to_vec()),
        ];
        let result = import_files(&mut lib.conn, lib.dir.path(), pack.id, &paths).unwrap();
        let files: Vec<_> = result.view.stickers.iter().map(|s| s.sticker.file_name.clone()).collect();
        assert_eq!(files, ["001.png", "002.png"]);
        assert_eq!(result.added_ids, result.view.stickers.iter().map(|s| s.sticker.id).collect::<Vec<_>>());
        // Imported stickers get no emoji, and are flagged for it.
        assert!(result.view.stickers.iter().all(|s| s.sticker.emoji_string.is_empty() && s.emoji_warning.is_some()));
        let rejected: Vec<_> = result.rejected.iter().map(|r| r.path.to_string_lossy().into_owned()).collect();
        assert_eq!(rejected, [paths[1].clone(), paths[3].clone()]);
        let content = |name: &str| {
            crate::library::test_images::tag_of(&fs::read(lib.dir.path().join("p").join(name)).unwrap())
        };
        assert_eq!(content("001.png"), "B");
        assert_eq!(content("002.png"), "A");
    }

    #[test]
    fn reorder_renames_files_on_disk_and_returns_the_new_view() {
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "P", None).unwrap();
        let paths: Vec<String> = ["A", "B", "C"]
            .iter()
            .map(|t| lib.source(&format!("{t}.png"), png(STICKER_SIDE, 1, t)))
            .collect();
        import_files(&mut lib.conn, lib.dir.path(), pack.id, &paths).unwrap();
        let first = load_stickers(&lib.conn, pack.id).unwrap()[0].id;
        let view = reorder(&mut lib.conn, lib.dir.path(), first, 3).unwrap();
        assert_eq!(view.stickers[2].sticker.id, first);
        let tag = |name: &str| crate::library::test_images::tag_of(&fs::read(lib.dir.path().join("p").join(name)).unwrap());
        assert_eq!([tag("001.png"), tag("002.png"), tag("003.png")], ["B", "C", "A"]);
    }

    #[test]
    fn import_result_serializes_camel_case() {
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "P", None).unwrap();
        let bad = lib.source("bad.png", png(1, 1, ""));
        let result = import_files(&mut lib.conn, lib.dir.path(), pack.id, &[bad]).unwrap();
        let json = serde_json::to_value(&result).unwrap();
        assert!(json["addedIds"].as_array().unwrap().is_empty());
        assert!(json["rejected"][0]["reason"].as_str().unwrap().contains("px"));
        assert_eq!(json["view"]["pack"]["shortName"], "p");
        assert!(json["view"]["thumbnailFile"].is_null());
    }

    #[test]
    fn pack_status_round_trips_from_the_webview() {
        let status: PackStatus = serde_json::from_str("\"live\"").unwrap();
        assert_eq!(status, PackStatus::Live);
        assert!(serde_json::from_str::<PackStatus>("\"published\"").is_err());
    }
}

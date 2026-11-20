//! Desync detection (SPEC §4): runs ONLY when a pack is opened and on
//! manual refresh — never on app start.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use super::packs::open_pack_files;
use super::schema::{load_pack, load_sticker, load_stickers, Pack, Sticker};
use super::stickers::{emoji_warning, image_dimensions, pack_size_warning, Warning};

/// What the pack view shows about a present file: its size, and its pixel
/// size when the header can be read (None for a damaged file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// File facts for `path`, or None when no file is there (Missing).
pub fn file_info(path: &Path) -> Option<FileInfo> {
    let meta = fs::metadata(path).ok().filter(|m| m.is_file())?;
    let (width, height) = match image_dimensions(path) {
        Ok((w, h)) => (Some(w), Some(h)),
        Err(_) => (None, None),
    };
    Some(FileInfo { bytes: meta.len(), width, height })
}

/// A sticker as the pack view shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerView {
    #[serde(flatten)]
    pub sticker: Sticker,
    pub missing: bool,
    pub emoji_warning: Option<Warning>,
    /// None when Missing.
    pub file: Option<FileInfo>,
}

/// An opened pack: rows plus derived Missing state and warnings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackView {
    pub pack: Pack,
    pub stickers: Vec<StickerView>,
    pub thumbnail_missing: bool,
    /// The thumbnail file, when the pack has one and it is present.
    pub thumbnail_file: Option<FileInfo>,
    pub pack_size_warning: Option<Warning>,
}

/// Open (or manually refresh) a pack. First repairs our own interrupted
/// work — a pending folder rename, then a pending rename plan (ADR-0004) —
/// so only genuine external desync remains; then derives Missing from file
/// presence (never stored). Call it on pack open and refresh only, never
/// on app start (SPEC §4).
pub fn open_pack(conn: &Connection, library_dir: &Path, pack_id: i64) -> Result<PackView, String> {
    let (pack, dir) = open_pack_files(conn, library_dir, pack_id)?;
    let stickers: Vec<StickerView> = load_stickers(conn, pack_id)?
        .into_iter()
        .map(|sticker| {
            let file = file_info(&dir.join(&sticker.file_name));
            StickerView {
                missing: file.is_none(),
                emoji_warning: emoji_warning(&sticker.emoji_string),
                file,
                sticker,
            }
        })
        .collect();
    let thumbnail_file = pack.thumbnail.as_ref().and_then(|name| file_info(&dir.join(name)));
    Ok(PackView {
        pack_size_warning: pack_size_warning(stickers.len()),
        thumbnail_missing: pack.thumbnail.is_some() && thumbnail_file.is_none(),
        thumbnail_file,
        pack,
        stickers,
    })
}

/// Where a sticker's file lives, after settling its pack folder; an error
/// when the file is absent (Missing). Used by Open in explorer, Edit, and
/// the pack view's previews.
pub fn sticker_file_path(conn: &Connection, library_dir: &Path, sticker_id: i64) -> Result<PathBuf, String> {
    let sticker = load_sticker(conn, sticker_id)?;
    let (_, dir) = open_pack_files(conn, library_dir, sticker.pack_id)?;
    // Re-read: settling may have finished a rename plan that renumbered it.
    let path = dir.join(load_sticker(conn, sticker_id)?.file_name);
    if !path.is_file() {
        return Err(format!("sticker {sticker_id} is Missing: {} is not in the pack folder", path.display()));
    }
    Ok(path)
}

/// Where a pack's thumbnail file lives; an error when the pack has none or
/// the file is absent.
pub fn thumbnail_file_path(conn: &Connection, library_dir: &Path, pack_id: i64) -> Result<PathBuf, String> {
    load_pack(conn, pack_id)?;
    let (pack, dir) = open_pack_files(conn, library_dir, pack_id)?;
    let name = pack.thumbnail.ok_or_else(|| format!("pack {pack_id} has no thumbnail"))?;
    let path = dir.join(name);
    if !path.is_file() {
        return Err(format!("the thumbnail {} is missing from the pack folder", path.display()));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::files::{apply_plan_with_fault, FaultPoint, Step};
    use crate::library::packs::{create_pack, pack_dir};
    use crate::library::schema::load_pack;
    use crate::library::stickers::{add_stickers, NewSticker};
    use rusqlite::params;
    use std::fs;
    use std::path::PathBuf;

    struct Lib {
        dir: tempfile::TempDir,
        sources: tempfile::TempDir,
        conn: Connection,
    }

    impl Lib {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            crate::library::create_fresh(dir.path()).unwrap();
            let conn = crate::library::open(dir.path()).unwrap();
            Lib { dir, sources: tempfile::tempdir().unwrap(), conn }
        }

        fn path(&self) -> &Path {
            self.dir.path()
        }

        /// A pack holding one PNG sticker per tag (file content = tag,
        /// emoji = tag unless empty).
        fn pack_with(&mut self, short_name: &str, tags: &[&str]) -> Pack {
            let pack = create_pack(&mut self.conn, self.dir.path(), short_name, Some(short_name)).unwrap();
            let items: Vec<NewSticker> = tags
                .iter()
                .map(|t| {
                    let path = self.sources.path().join(format!("{t}.png"));
                    fs::write(&path, crate::library::test_images::png(t)).unwrap();
                    NewSticker { path, emoji_string: t.to_string() }
                })
                .collect();
            add_stickers(&mut self.conn, self.dir.path(), pack.id, &items, None).unwrap();
            pack
        }

        fn dir_of(&self, pack_id: i64) -> PathBuf {
            pack_dir(self.path(), &load_pack(&self.conn, pack_id).unwrap())
        }

        fn open(&self, pack_id: i64) -> PackView {
            open_pack(&self.conn, self.path(), pack_id).unwrap()
        }
    }

    fn missing(view: &PackView) -> Vec<bool> {
        view.stickers.iter().map(|s| s.missing).collect()
    }

    fn content(lib: &Lib, pack_id: i64, file: &str) -> String {
        crate::library::test_images::tag_of(&fs::read(lib.dir_of(pack_id).join(file)).unwrap())
    }

    #[test]
    fn a_consistent_pack_opens_with_nothing_missing() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B"]);
        let view = lib.open(pack.id);
        assert_eq!(view.pack.id, pack.id);
        assert_eq!(missing(&view), [false, false]);
        assert_eq!(view.stickers[1].sticker.file_name, "002.png");
        assert!(!view.thumbnail_missing);
        assert_eq!(view.pack_size_warning, None);
    }

    #[test]
    fn an_absent_file_marks_its_sticker_missing() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B", "C"]);
        fs::remove_file(lib.dir_of(pack.id).join("002.png")).unwrap();
        assert_eq!(missing(&lib.open(pack.id)), [false, true, false]);
    }

    #[test]
    fn a_file_renamed_outside_the_app_reads_as_missing() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B"]);
        let dir = lib.dir_of(pack.id);
        fs::rename(dir.join("001.png"), dir.join("cat.png")).unwrap();
        assert_eq!(missing(&lib.open(pack.id)), [true, false]);
        // Stray files are not adopted (no reconstruction, SPEC §3).
        assert!(dir.join("cat.png").is_file());
    }

    #[test]
    fn an_interrupted_rename_is_rolled_forward_before_detection() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B"]);
        let dir = lib.dir_of(pack.id);
        // Crash mid-swap: the decision committed, both files sit in temps.
        let steps = [Step::rename("001.png", "002.png"), Step::rename("002.png", "001.png")];
        let err = apply_plan_with_fault(
            &mut lib.conn,
            &dir,
            pack.id,
            &steps,
            |tx| {
                tx.execute_batch(
                    "UPDATE stickers SET position = position + 1000000, file_name = '.dbtmp-' || id;
                     UPDATE stickers SET position = 3 - (position - 1000000),
                                         file_name = printf('%03d.png', 3 - (position - 1000000));",
                )
                .map_err(|e| e.to_string())
            },
            &|p| if p == FaultPoint::AfterPhase1 { Err("crash".into()) } else { Ok(()) },
        )
        .unwrap_err();
        assert_eq!(err, "crash");
        assert!(!dir.join("001.png").exists(), "files should be in temps");
        let view = lib.open(pack.id);
        // No false Missing from our own half-finished renames (ADR-0004).
        assert_eq!(missing(&view), [false, false]);
        assert_eq!(content(&lib, pack.id, "001.png"), "B");
        assert_eq!(content(&lib, pack.id, "002.png"), "A");
        assert_eq!(view.stickers[0].sticker.emoji_string, "B");
    }

    #[test]
    fn a_pending_folder_rename_is_settled_before_detection() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("before", &["A"]);
        lib.conn
            .execute(
                "UPDATE packs SET short_name = 'after', folder_rename_from = 'before' WHERE id = ?1",
                params![pack.id],
            )
            .unwrap();
        let view = lib.open(pack.id);
        assert_eq!(view.pack.folder_rename_from, None);
        assert_eq!(missing(&view), [false]);
        assert!(lib.path().join("after").join("001.png").is_file());
    }

    #[test]
    fn a_pack_folder_deleted_outside_the_app_marks_everything_missing() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B"]);
        fs::remove_dir_all(lib.dir_of(pack.id)).unwrap();
        let view = lib.open(pack.id);
        assert_eq!(missing(&view), [true, true]);
        // The folder is recreated so replacements have somewhere to land.
        assert!(lib.dir_of(pack.id).is_dir());
    }

    #[test]
    fn a_thumbnail_without_its_file_is_flagged() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &[]);
        lib.conn
            .execute("UPDATE packs SET thumbnail = 'thumbnail.png' WHERE id = ?1", params![pack.id])
            .unwrap();
        assert!(lib.open(pack.id).thumbnail_missing);
        fs::write(lib.dir_of(pack.id).join("thumbnail.png"), "t").unwrap();
        assert!(!lib.open(pack.id).thumbnail_missing);
    }

    #[test]
    fn present_files_report_their_size_and_dimensions() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B"]);
        lib.conn
            .execute("UPDATE packs SET thumbnail = 'thumbnail.png' WHERE id = ?1", params![pack.id])
            .unwrap();
        fs::write(lib.dir_of(pack.id).join("thumbnail.png"), "not an image").unwrap();
        fs::remove_file(lib.dir_of(pack.id).join("002.png")).unwrap();
        let view = lib.open(pack.id);
        let bytes = fs::metadata(lib.dir_of(pack.id).join("001.png")).unwrap().len();
        let side = crate::limits::STICKER_SIDE;
        assert_eq!(view.stickers[0].file, Some(FileInfo { bytes, width: Some(side), height: Some(1) }));
        assert_eq!(view.stickers[1].file, None);
        // A damaged file is present (not Missing) but has no readable size.
        assert_eq!(view.thumbnail_file, Some(FileInfo { bytes: 12, width: None, height: None }));
        assert!(!view.thumbnail_missing);
    }

    #[test]
    fn file_paths_resolve_present_files_and_refuse_missing_ones() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B"]);
        let stickers = load_stickers(&lib.conn, pack.id).unwrap();
        let path = sticker_file_path(&lib.conn, lib.path(), stickers[1].id).unwrap();
        assert_eq!(path, lib.dir_of(pack.id).join("002.png"));
        fs::remove_file(&path).unwrap();
        assert!(sticker_file_path(&lib.conn, lib.path(), stickers[1].id).unwrap_err().contains("Missing"));
        assert!(thumbnail_file_path(&lib.conn, lib.path(), pack.id).unwrap_err().contains("no thumbnail"));
        lib.conn
            .execute("UPDATE packs SET thumbnail = 'thumbnail.webp' WHERE id = ?1", params![pack.id])
            .unwrap();
        assert!(thumbnail_file_path(&lib.conn, lib.path(), pack.id).is_err());
        fs::write(lib.dir_of(pack.id).join("thumbnail.webp"), "t").unwrap();
        assert_eq!(
            thumbnail_file_path(&lib.conn, lib.path(), pack.id).unwrap(),
            lib.dir_of(pack.id).join("thumbnail.webp")
        );
    }

    #[test]
    fn file_paths_follow_a_settled_folder_rename() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("before", &["A"]);
        lib.conn
            .execute(
                "UPDATE packs SET short_name = 'after', folder_rename_from = 'before' WHERE id = ?1",
                params![pack.id],
            )
            .unwrap();
        let id = load_stickers(&lib.conn, pack.id).unwrap()[0].id;
        assert_eq!(sticker_file_path(&lib.conn, lib.path(), id).unwrap(), lib.path().join("after").join("001.png"));
    }

    #[test]
    fn warnings_are_surfaced_per_sticker() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A"]);
        lib.conn
            .execute("UPDATE stickers SET emoji_string = '' WHERE pack_id = ?1", params![pack.id])
            .unwrap();
        let view = lib.open(pack.id);
        assert_eq!(view.stickers[0].emoji_warning, Some(Warning::EmojiCount { count: 0 }));
    }

    #[test]
    fn opening_an_unknown_pack_is_an_error() {
        let lib = Lib::new();
        assert!(open_pack(&lib.conn, lib.path(), 999).is_err());
    }

    #[test]
    fn the_view_serializes_flat_and_camel_case() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A"]);
        let json = serde_json::to_value(lib.open(pack.id)).unwrap();
        let sticker = &json["stickers"][0];
        assert_eq!(sticker["fileName"], "001.png");
        assert_eq!(sticker["missing"], false);
        assert!(sticker.get("sticker").is_none(), "sticker fields must be flattened");
        assert_eq!(json["pack"]["shortName"], "p");
        assert_eq!(json["thumbnailMissing"], false);
    }
}

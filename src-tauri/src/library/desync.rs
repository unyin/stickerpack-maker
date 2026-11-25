//! Desync detection (SPEC §4): runs when a pack is opened, on manual
//! refresh, and each time the Pack list is shown (SPM-25) — never on app
//! start.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

use super::packs::open_pack_files;
use super::schema::{load_packs, load_sticker, load_stickers, Format, Pack, Sticker};
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

/// The first sticker of a pack, which stands in for a missing thumbnail
/// (Telegram shows it) and so is what the Pack list's row previews.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstSticker {
    pub id: i64,
    pub format: Format,
    pub missing: bool,
}

/// One pack as the Pack list shows it (SPM-25): plain facts from the same
/// check as opening the pack; the issue rule that turns them into a badge is
/// the webview's (one definition, `pack-issues.ts`). `check_error` is set
/// when the check itself failed (e.g. the pack folder cannot be settled): the
/// row then carries what the database knows and nothing about files.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackListEntry {
    #[serde(flatten)]
    pub pack: Pack,
    pub sticker_count: i64,
    pub missing_count: i64,
    pub thumbnail_missing: bool,
    /// Every sticker's Emoji String, in position order.
    pub emoji_strings: Vec<String>,
    pub first_sticker: Option<FirstSticker>,
    pub check_error: Option<String>,
}

fn entry_from_view(view: PackView) -> PackListEntry {
    PackListEntry {
        sticker_count: view.stickers.len() as i64,
        missing_count: view.stickers.iter().filter(|s| s.missing).count() as i64,
        thumbnail_missing: view.thumbnail_missing,
        emoji_strings: view.stickers.iter().map(|s| s.sticker.emoji_string.clone()).collect(),
        first_sticker: view.stickers.first().map(|s| FirstSticker {
            id: s.sticker.id,
            format: s.sticker.format,
            missing: s.missing,
        }),
        pack: view.pack,
        check_error: None,
    }
}

/// What the database alone knows of a pack whose check failed.
fn entry_unchecked(conn: &Connection, pack: Pack, error: String) -> PackListEntry {
    let stickers = load_stickers(conn, pack.id).unwrap_or_default();
    PackListEntry {
        sticker_count: stickers.len() as i64,
        missing_count: 0,
        thumbnail_missing: false,
        emoji_strings: stickers.iter().map(|s| s.emoji_string.clone()).collect(),
        first_sticker: stickers.first().map(|s| FirstSticker { id: s.id, format: s.format, missing: false }),
        pack,
        check_error: Some(error),
    }
}

/// The Pack list's facts (SPM-25, owner decision): EVERY pack gets the full
/// open check — recovery first (ADR-0004), then the presence scan, remembered
/// in `memo` exactly as `open_pack` does — each time the list is shown. A pack
/// whose check fails is reported per pack (`check_error`), never failing the
/// whole list. Packs come in the stored display order.
pub fn list_pack_facts(conn: &Connection, library_dir: &Path, memo: &PresenceMemo) -> Result<Vec<PackListEntry>, String> {
    Ok(load_packs(conn)?
        .into_iter()
        .map(|pack| match build_view(conn, library_dir, pack.id, memo, true) {
            Ok(view) => entry_from_view(view),
            Err(error) => entry_unchecked(conn, pack, error),
        })
        .collect())
}

/// What the last explicit check (pack open or Refresh) found per file, kept
/// in memory so operations can refresh the view WITHOUT re-scanning for
/// Missing (SPEC §4/§5: desync checks run only on open and Refresh).
/// Tauri-free: the app holds one next to its Library lock.
#[derive(Default)]
pub struct PresenceMemo(Mutex<HashMap<i64, PackPresence>>);

/// One pack's remembered check: file facts per sticker id (None = Missing)
/// and the thumbnail's, keyed by the file name it was read under.
#[derive(Clone, Default)]
struct PackPresence {
    stickers: HashMap<i64, Option<FileInfo>>,
    thumbnail: Option<(String, Option<FileInfo>)>,
}

impl PresenceMemo {
    fn get(&self, pack_id: i64) -> PackPresence {
        self.lock().get(&pack_id).cloned().unwrap_or_default()
    }

    fn set(&self, pack_id: i64, presence: PackPresence) {
        self.lock().insert(pack_id, presence);
    }

    /// Forget one sticker's remembered file, after its file was rewritten
    /// by an operation: the next view reads the new file once.
    pub fn forget_sticker(&self, pack_id: i64, sticker_id: i64) {
        if let Some(p) = self.lock().get_mut(&pack_id) {
            p.stickers.remove(&sticker_id);
        }
    }

    /// Forget the remembered thumbnail file, after it was written or removed by
    /// an operation: the next view reads the folder once.
    pub fn forget_thumbnail(&self, pack_id: i64) {
        if let Some(p) = self.lock().get_mut(&pack_id) {
            p.thumbnail = None;
        }
    }

    /// Forget everything (the active Library changed: pack ids no longer
    /// mean the same packs).
    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<i64, PackPresence>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Open (or manually refresh) a pack: the EXPLICIT desync check. First
/// repairs our own interrupted work — a pending folder rename, then a
/// pending rename plan (ADR-0004) — so only genuine external desync
/// remains; then derives Missing from file presence (never stored) and
/// remembers it in `memo`. Call it on pack open and refresh only, never on
/// app start (SPEC §4) nor after an operation (use `load_pack_view`).
pub fn open_pack(conn: &Connection, library_dir: &Path, pack_id: i64, memo: &PresenceMemo) -> Result<PackView, String> {
    build_view(conn, library_dir, pack_id, memo, true)
}

/// The pack's rows as a view WITHOUT a presence scan: recovery and settling
/// still run first (ADR-0004), but Missing flags and file facts stay as the
/// last explicit check left them; only stickers it never saw (just added or
/// replaced) are read from disk.
pub fn load_pack_view(conn: &Connection, library_dir: &Path, pack_id: i64, memo: &PresenceMemo) -> Result<PackView, String> {
    build_view(conn, library_dir, pack_id, memo, false)
}

fn build_view(conn: &Connection, library_dir: &Path, pack_id: i64, memo: &PresenceMemo, scan: bool) -> Result<PackView, String> {
    let (pack, dir) = open_pack_files(conn, library_dir, pack_id)?;
    let known = if scan { PackPresence::default() } else { memo.get(pack_id) };
    let mut presence = PackPresence::default();
    let stickers: Vec<StickerView> = load_stickers(conn, pack_id)?
        .into_iter()
        .map(|sticker| {
            let file = match known.stickers.get(&sticker.id) {
                Some(remembered) => remembered.clone(),
                None => file_info(&dir.join(&sticker.file_name)),
            };
            presence.stickers.insert(sticker.id, file.clone());
            StickerView {
                missing: file.is_none(),
                emoji_warning: emoji_warning(&sticker.emoji_string),
                file,
                sticker,
            }
        })
        .collect();
    let thumbnail_file = pack.thumbnail.as_ref().and_then(|name| {
        let file = match &known.thumbnail {
            Some((known_name, remembered)) if known_name == name => remembered.clone(),
            _ => file_info(&dir.join(name)),
        };
        presence.thumbnail = Some((name.clone(), file.clone()));
        file
    });
    memo.set(pack_id, presence);
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
    // open_pack_files loads the pack (an unknown id errors there).
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
        memo: PresenceMemo,
    }

    impl Lib {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            crate::library::create_fresh(dir.path()).unwrap();
            let conn = crate::library::open(dir.path()).unwrap();
            Lib { dir, sources: tempfile::tempdir().unwrap(), conn, memo: PresenceMemo::default() }
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
            open_pack(&self.conn, self.path(), pack_id, &self.memo).unwrap()
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
    fn a_view_load_keeps_the_last_check_until_the_next_explicit_one() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B", "C"]);
        assert_eq!(missing(&lib.open(pack.id)), [false, false, false]);
        fs::remove_file(lib.dir_of(pack.id).join("002.png")).unwrap();
        let view = load_pack_view(&lib.conn, lib.path(), pack.id, &lib.memo).unwrap();
        assert_eq!(missing(&view), [false, false, false]);
        assert!(view.stickers[1].file.is_some());
        // The explicit check finds it, and later loads keep that result.
        assert_eq!(missing(&lib.open(pack.id)), [false, true, false]);
        let view = load_pack_view(&lib.conn, lib.path(), pack.id, &lib.memo).unwrap();
        assert_eq!(missing(&view), [false, true, false]);
    }

    #[test]
    fn clearing_the_memo_forgets_the_last_check() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B"]);
        fs::remove_file(lib.dir_of(pack.id).join("002.png")).unwrap();
        assert_eq!(missing(&lib.open(pack.id)), [false, true]);
        // A Library change clears the memo: a plain view load no longer
        // reports the remembered Missing, it reads files afresh.
        lib.memo.clear();
        let view = load_pack_view(&lib.conn, lib.path(), pack.id, &lib.memo).unwrap();
        assert_eq!(missing(&view), [false, true]); // still absent on disk, now freshly read
        fs::write(lib.dir_of(pack.id).join("002.png"), crate::library::test_images::png("B")).unwrap();
        lib.memo.clear();
        let view = load_pack_view(&lib.conn, lib.path(), pack.id, &lib.memo).unwrap();
        assert_eq!(missing(&view), [false, false]);
    }

    #[test]
    fn a_view_load_reads_only_stickers_the_check_never_saw() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A"]);
        lib.open(pack.id);
        let path = lib.sources.path().join("N.png");
        fs::write(&path, crate::library::test_images::png("N")).unwrap();
        let dir = lib.dir.path().to_path_buf();
        add_stickers(&mut lib.conn, &dir, pack.id, &[NewSticker { path, emoji_string: String::new() }], None).unwrap();
        let view = load_pack_view(&lib.conn, lib.path(), pack.id, &lib.memo).unwrap();
        assert_eq!(missing(&view), [false, false]);
        assert!(view.stickers[1].file.is_some());
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
        assert!(open_pack(&lib.conn, lib.path(), 999, &lib.memo).is_err());
        assert!(thumbnail_file_path(&lib.conn, lib.path(), 999).is_err());
    }

    // ---- The Pack list's facts (SPM-25) ----

    #[test]
    fn list_facts_count_stickers_missing_and_emoji_in_position_order() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B", "C"]);
        lib.pack_with("q", &[]);
        fs::remove_file(lib.dir_of(pack.id).join("002.png")).unwrap();
        fs::remove_file(lib.dir_of(pack.id).join("003.png")).unwrap();
        let facts = list_pack_facts(&lib.conn, lib.path(), &lib.memo).unwrap();
        // Stored order: newest first.
        assert_eq!(facts.iter().map(|f| f.pack.short_name.as_str()).collect::<Vec<_>>(), ["q", "p"]);
        let (q, p) = (&facts[0], &facts[1]);
        assert_eq!((p.sticker_count, p.missing_count), (3, 2));
        assert_eq!(p.emoji_strings, ["A", "B", "C"]);
        assert!(!p.thumbnail_missing);
        let first = p.first_sticker.as_ref().unwrap();
        assert_eq!((first.missing, first.format), (false, Format::Png));
        assert_eq!(p.check_error, None);
        assert_eq!((q.sticker_count, q.missing_count), (0, 0));
        assert!(q.emoji_strings.is_empty());
        assert_eq!(q.first_sticker, None);
    }

    #[test]
    fn list_facts_flag_a_missing_first_sticker_and_a_missing_thumbnail() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B"]);
        lib.conn
            .execute("UPDATE packs SET thumbnail = 'thumbnail.png' WHERE id = ?1", params![pack.id])
            .unwrap();
        fs::remove_file(lib.dir_of(pack.id).join("001.png")).unwrap();
        let facts = list_pack_facts(&lib.conn, lib.path(), &lib.memo).unwrap();
        assert!(facts[0].thumbnail_missing);
        assert!(facts[0].first_sticker.as_ref().unwrap().missing);
        assert_eq!(facts[0].missing_count, 1);
        fs::write(lib.dir_of(pack.id).join("thumbnail.png"), "t").unwrap();
        assert!(!list_pack_facts(&lib.conn, lib.path(), &lib.memo).unwrap()[0].thumbnail_missing);
    }

    #[test]
    fn list_facts_rescan_each_time_and_update_the_presence_memo_like_an_open() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B"]);
        assert_eq!(list_pack_facts(&lib.conn, lib.path(), &lib.memo).unwrap()[0].missing_count, 0);
        fs::remove_file(lib.dir_of(pack.id).join("002.png")).unwrap();
        // Showing the list again is a new check, so it sees the loss...
        assert_eq!(list_pack_facts(&lib.conn, lib.path(), &lib.memo).unwrap()[0].missing_count, 1);
        // ...and a later plain view load keeps what that check found.
        let view = load_pack_view(&lib.conn, lib.path(), pack.id, &lib.memo).unwrap();
        assert_eq!(missing(&view), [false, true]);
    }

    #[test]
    fn list_facts_recover_an_interrupted_rename_first_so_nothing_reads_falsely_missing() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("p", &["A", "B"]);
        let dir = lib.dir_of(pack.id);
        let steps = [Step::rename("001.png", "002.png"), Step::rename("002.png", "001.png")];
        apply_plan_with_fault(
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
        assert!(!dir.join("001.png").exists(), "files should be in temps");
        let facts = list_pack_facts(&lib.conn, lib.path(), &lib.memo).unwrap();
        assert_eq!((facts[0].sticker_count, facts[0].missing_count), (2, 0));
        assert_eq!(facts[0].emoji_strings, ["B", "A"]);
        assert_eq!(content(&lib, pack.id, "001.png"), "B");
    }

    #[test]
    fn list_facts_settle_a_pending_folder_rename() {
        let mut lib = Lib::new();
        let pack = lib.pack_with("before", &["A"]);
        lib.conn
            .execute(
                "UPDATE packs SET short_name = 'after', folder_rename_from = 'before' WHERE id = ?1",
                params![pack.id],
            )
            .unwrap();
        let facts = list_pack_facts(&lib.conn, lib.path(), &lib.memo).unwrap();
        assert_eq!(facts[0].pack.folder_rename_from, None);
        assert_eq!(facts[0].missing_count, 0);
    }

    #[test]
    fn a_pack_whose_check_fails_is_reported_per_pack_and_does_not_break_the_list() {
        let mut lib = Lib::new();
        let bad = lib.pack_with("old", &["A", "B"]);
        lib.pack_with("good", &["C"]);
        // Both the old and the new folder exist: modified outside the app,
        // which settling refuses to guess about (ADR-0004).
        lib.conn
            .execute(
                "UPDATE packs SET short_name = 'new', folder_rename_from = 'old' WHERE id = ?1",
                params![bad.id],
            )
            .unwrap();
        fs::create_dir(lib.path().join("new")).unwrap();
        let facts = list_pack_facts(&lib.conn, lib.path(), &lib.memo).unwrap();
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].check_error, None);
        assert_eq!(facts[0].sticker_count, 1);
        let failed = &facts[1];
        assert!(failed.check_error.as_ref().unwrap().contains("modified outside the app"));
        // What the database alone knows is still shown.
        assert_eq!((failed.sticker_count, failed.missing_count), (2, 0));
        assert_eq!(failed.emoji_strings, ["A", "B"]);
    }

    #[test]
    fn list_facts_serialize_flat_and_camel_case() {
        let mut lib = Lib::new();
        lib.pack_with("p", &["A"]);
        let json = serde_json::to_value(list_pack_facts(&lib.conn, lib.path(), &lib.memo).unwrap()).unwrap();
        let row = &json[0];
        assert_eq!(row["shortName"], "p");
        assert_eq!(row["stickerCount"], 1);
        assert_eq!(row["missingCount"], 0);
        assert_eq!(row["thumbnailMissing"], false);
        assert_eq!(row["emojiStrings"][0], "A");
        assert_eq!(row["firstSticker"]["format"], "png");
        assert_eq!(row["firstSticker"]["missing"], false);
        assert!(row["checkError"].is_null());
    }

    /// Cost of showing the Pack list with a large Library: 50 packs x 120
    /// stickers of real small files, every pack fully checked. Ignored by
    /// default (it writes 6000 files); run with
    /// `cargo test --release list_facts_timing -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn list_facts_timing_for_a_large_library() {
        let mut lib = Lib::new();
        let tags: Vec<String> = (0..120).map(|i| format!("t{i}")).collect();
        let tags: Vec<&str> = tags.iter().map(String::as_str).collect();
        for n in 0..50 {
            lib.pack_with(&format!("pack_{n}"), &tags);
        }
        for run in 1..=3 {
            let started = std::time::Instant::now();
            let facts = list_pack_facts(&lib.conn, lib.path(), &lib.memo).unwrap();
            let took = started.elapsed();
            assert_eq!(facts.len(), 50);
            assert!(facts.iter().all(|f| f.sticker_count == 120 && f.missing_count == 0));
            println!("list_pack_facts, 50 packs x 120 stickers, run {run}: {took:?}");
        }
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

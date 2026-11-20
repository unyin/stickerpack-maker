//! Pack operations and Title / Short Name validation (SPEC §3, §7).
//!
//! Create, edit, status toggle and delete follow ADR-0004's commit-first
//! ordering for the pack folder: creation commits only once `pack_<id>`
//! exists; deletion commits the row removal before touching the folder.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;

use super::schema::{load_pack, Pack, PackStatus};

/// Folder of `pack` inside the Library.
pub fn pack_dir(library_dir: &Path, pack: &Pack) -> PathBuf {
    library_dir.join(&pack.folder)
}

/// Folder name for pack `id` (`pack_<id>`): stable across Title and Short
/// Name edits, which is why it does not derive from either.
fn folder_name(pack_id: i64) -> String {
    format!("pack_{pack_id}")
}

/// True only for folder names this module produces. Guards every
/// recursive delete: a corrupted `folder` column ('', '..', a path) must
/// never resolve to the Library itself or anything outside it.
fn is_pack_folder_name(name: &str) -> bool {
    name.strip_prefix("pack_")
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
}

/// Create a pack (Draft, SPEC §3). `short_name` is validated when given,
/// otherwise auto-derived from the Title. The `pack_<id>` folder is created
/// inside the transaction, before commit, so a committed pack always has its
/// folder (ADR-0004). An existing EMPTY folder of that name is a harmless
/// pre-commit crash orphan and is adopted; a non-empty one was not made by
/// this create and is refused rather than silently absorbed.
pub fn create_pack(
    conn: &mut Connection,
    library_dir: &Path,
    title: &str,
    short_name: Option<&str>,
) -> Result<Pack, String> {
    let title = validate_title(title)?;
    let short_name = match short_name {
        Some(given) => {
            validate_short_name(given)?;
            given.to_string()
        }
        None => auto_short_name(&title),
    };

    let tx = conn
        .transaction()
        .map_err(|e| format!("cannot start transaction: {e}"))?;
    tx.execute(
        "INSERT INTO packs (title, short_name, folder) VALUES (?1, ?2, '')",
        params![title, short_name],
    )
    .map_err(|e| format!("cannot create pack: {e}"))?;
    let pack_id = tx.last_insert_rowid();
    let folder = folder_name(pack_id);
    let dir = library_dir.join(&folder);
    let created_dir = prepare_pack_folder(&dir)?;
    let committed = tx
        .execute(
            "UPDATE packs SET folder = ?1 WHERE id = ?2",
            params![folder, pack_id],
        )
        .map_err(|e| format!("cannot record pack folder: {e}"))
        .and_then(|_| tx.commit().map_err(|e| format!("cannot commit new pack: {e}")));
    if let Err(e) = committed {
        // Not committed: the empty folder we just made is undone (best
        // effort; if this fails too it is the accepted empty orphan).
        if created_dir {
            let _ = fs::remove_dir(&dir);
        }
        return Err(e);
    }
    load_pack(conn, pack_id)
}

/// Ensure `dir` exists as an empty folder. Returns true when this call
/// created it (so a failed commit knows to undo it).
fn prepare_pack_folder(dir: &Path) -> Result<bool, String> {
    if dir.exists() {
        let empty = dir.is_dir()
            && fs::read_dir(dir)
                .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
                .next()
                .is_none();
        if !empty {
            return Err(format!(
                "cannot create pack: {} already exists and is not an empty folder; \
                 it was not created for this pack, so move or remove it first",
                dir.display()
            ));
        }
        return Ok(false);
    }
    fs::create_dir(dir).map_err(|e| format!("cannot create pack folder {}: {e}", dir.display()))?;
    Ok(true)
}

/// Run a single-row pack UPDATE and return the updated pack; an unknown id
/// is an error (no row changed).
fn update_pack(conn: &Connection, pack_id: i64, sql: &str, value: &str) -> Result<Pack, String> {
    let changed = conn
        .execute(sql, params![value, pack_id])
        .map_err(|e| format!("cannot update pack {pack_id}: {e}"))?;
    if changed == 0 {
        return Err(format!("pack {pack_id} does not exist"));
    }
    load_pack(conn, pack_id)
}

/// Edit a pack's Title; always allowed, Draft or Live (SPEC §3). Never
/// touches the Short Name or the folder.
pub fn set_title(conn: &Connection, pack_id: i64, title: &str) -> Result<Pack, String> {
    let title = validate_title(title)?;
    update_pack(conn, pack_id, "UPDATE packs SET title = ?1 WHERE id = ?2", &title)
}

/// Edit a pack's Short Name; Draft only. Locked once Live because Telegram
/// short names are immutable after creation (SPEC §3).
pub fn set_short_name(conn: &Connection, pack_id: i64, short_name: &str) -> Result<Pack, String> {
    validate_short_name(short_name)?;
    if load_pack(conn, pack_id)?.status == PackStatus::Live {
        return Err(
            "Short Name is locked while the pack is Live (Telegram short names cannot change)"
                .to_string(),
        );
    }
    update_pack(
        conn,
        pack_id,
        "UPDATE packs SET short_name = ?1 WHERE id = ?2",
        short_name,
    )
}

/// Toggle Draft/Live, both ways (SPEC §3). The Live→Draft warning is UI
/// (SPM-3); in v1 status changes only the badge and the Short Name lock.
pub fn set_status(conn: &Connection, pack_id: i64, status: PackStatus) -> Result<Pack, String> {
    update_pack(
        conn,
        pack_id,
        "UPDATE packs SET status = ?1 WHERE id = ?2",
        status.as_str(),
    )
}

/// A pack folder that survived a committed pack deletion.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverFolder {
    pub path: PathBuf,
    pub reason: String,
}

/// Delete a pack, Draft or Live alike: both remove the local folder and
/// files (SPEC §3); confirmation and the Live "Telegram pack remains"
/// warning are UI (SPM-3). Commit-first (ADR-0004): the row deletion
/// (cascading stickers and journal) commits, THEN the folder is removed.
/// `Ok(Some(leftover))` means the pack is gone from the Library but its
/// folder could not be removed — reported, never a row pointing at nothing.
pub fn delete_pack(
    conn: &Connection,
    library_dir: &Path,
    pack_id: i64,
) -> Result<Option<LeftoverFolder>, String> {
    let pack = load_pack(conn, pack_id)?;
    if !is_pack_folder_name(&pack.folder) {
        return Err(format!(
            "refusing to delete pack {pack_id}: its folder {:?} is not a pack folder name",
            pack.folder
        ));
    }
    conn.execute("DELETE FROM packs WHERE id = ?1", params![pack_id])
        .map_err(|e| format!("cannot delete pack {pack_id}: {e}"))?;
    let dir = pack_dir(library_dir, &pack);
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Ok(Some(LeftoverFolder {
            path: dir,
            reason: e.to_string(),
        })),
    }
}

/// Validate a Title: free text, 1–64 characters after trimming (SPEC §7).
/// Returns the trimmed Title to store.
pub fn validate_title(title: &str) -> Result<String, String> {
    let trimmed = title.trim();
    let len = trimmed.chars().count();
    if len == 0 || len > 64 {
        return Err(format!(
            "Title must be 1–64 characters (got {len}); a Title is always required"
        ));
    }
    Ok(trimmed.to_string())
}

/// Validate a Short Name against Telegram's slug rules (SPEC §3/§7):
/// letters/digits/underscores, begins with a letter, no consecutive
/// underscores, at most 64 characters. Enforced in the core, not just the UI.
pub fn validate_short_name(short_name: &str) -> Result<(), String> {
    if short_name.is_empty() {
        return Err("Short Name must not be empty".to_string());
    }
    if short_name.chars().count() > 64 {
        return Err("Short Name must be at most 64 characters".to_string());
    }
    if !short_name.chars().next().unwrap().is_ascii_alphabetic() {
        return Err("Short Name must begin with a letter".to_string());
    }
    if !short_name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err("Short Name may only contain letters, digits, and underscores".to_string());
    }
    if short_name.contains("__") {
        return Err("Short Name must not contain consecutive underscores".to_string());
    }
    Ok(())
}

/// Auto-derive a Short Name from a Title (SPEC §3): lowercase, runs of
/// non-alphanumeric characters collapse to a single underscore, no leading
/// or trailing underscore. Titles without letters get a `pack` prefix so the
/// result always begins with a letter; the result is truncated to 64
/// characters and always passes `validate_short_name`.
pub fn auto_short_name(title: &str) -> String {
    let mut out = String::new();
    let mut pending_separator = false;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_separator && !out.is_empty() {
                out.push('_');
            }
            pending_separator = false;
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() {
            pending_separator = true;
        }
    }
    if out.is_empty() {
        out.push_str("pack");
    } else if !out.starts_with(|c: char| c.is_ascii_alphabetic()) {
        out = format!("pack_{out}");
    }
    // Truncate to 64 chars; a trailing underscore from the cut is trimmed.
    // The construction never produces consecutive underscores.
    let truncated: String = out.chars().take(64).collect();
    truncated.trim_end_matches('_').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_name_accepts_telegram_slugs() {
        for good in ["a", "abc", "A_1", "My_Pack_2", &"x".repeat(64)] {
            assert!(validate_short_name(good).is_ok(), "rejected {good:?}");
        }
    }

    #[test]
    fn short_name_rejects_invalid_slugs() {
        for bad in [
            "",            // empty
            "1abc",        // must begin with a letter
            "_abc",        // must begin with a letter
            "a__b",        // no consecutive underscores
            "a b",         // space
            "a-b",         // hyphen
            "héllo",       // non-ASCII letter
            &"x".repeat(65), // too long
        ] {
            assert!(validate_short_name(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn title_is_trimmed_and_length_checked() {
        assert_eq!(validate_title("  My Pack  ").unwrap(), "My Pack");
        assert!(validate_title("").is_err());
        assert!(validate_title("   ").is_err());
        assert!(validate_title(&"x".repeat(64)).is_ok());
        assert!(validate_title(&"x".repeat(65)).is_err());
    }

    #[test]
    fn auto_short_name_derives_from_title() {
        assert_eq!(auto_short_name("My Cool Pack!"), "my_cool_pack");
        assert_eq!(auto_short_name("A  B"), "a_b");
        assert_eq!(auto_short_name("  Hello, World!  "), "hello_world");
        // No letters to start with: prefix so the result begins with a letter.
        assert_eq!(auto_short_name("123"), "pack_123");
        assert_eq!(auto_short_name("!!!"), "pack");
        assert_eq!(auto_short_name(""), "pack");
    }

    #[test]
    fn auto_short_name_is_always_valid() {
        let long = format!("{} tail", "word ".repeat(40));
        for title in [
            "My Cool Pack!",
            "123",
            "!!!",
            "",
            "Ünïcödé Tïtlé",
            "a__b",
            &long,
            &"x".repeat(300),
            &format!("{}_", "y".repeat(70)),
        ] {
            let short = auto_short_name(title);
            assert!(
                validate_short_name(&short).is_ok(),
                "auto_short_name({title:?}) = {short:?} is invalid"
            );
            assert!(short.chars().count() <= 64);
        }
    }

    // ---- Pack operations (Library-backed) ----

    struct Lib {
        dir: tempfile::TempDir,
        conn: Connection,
    }

    impl Lib {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            crate::library::create_fresh(dir.path()).unwrap();
            let conn = crate::library::open(dir.path()).unwrap();
            Lib { dir, conn }
        }

        fn path(&self) -> &Path {
            self.dir.path()
        }

        fn create(&mut self, title: &str, short_name: Option<&str>) -> Result<Pack, String> {
            create_pack(&mut self.conn, self.dir.path(), title, short_name)
        }

        fn pack_count(&self) -> i64 {
            self.conn
                .query_row("SELECT COUNT(*) FROM packs", [], |r| r.get(0))
                .unwrap()
        }
    }

    #[test]
    fn create_pack_is_draft_with_auto_short_name_and_its_own_folder() {
        let mut lib = Lib::new();
        let pack = lib.create("  My Cool Pack!  ", None).unwrap();
        assert_eq!(pack.title, "My Cool Pack!");
        assert_eq!(pack.short_name, "my_cool_pack");
        assert_eq!(pack.status, PackStatus::Draft);
        assert_eq!(pack.folder, format!("pack_{}", pack.id));
        assert_eq!(pack.thumbnail, None);
        assert!(pack_dir(lib.path(), &pack).is_dir());
        // Persisted exactly as returned.
        let stored = load_pack(&lib.conn, pack.id).unwrap();
        assert_eq!(stored.short_name, pack.short_name);
        assert_eq!(stored.folder, pack.folder);
    }

    #[test]
    fn create_pack_accepts_a_valid_explicit_short_name() {
        let mut lib = Lib::new();
        let pack = lib.create("Title", Some("Custom_Name_1")).unwrap();
        assert_eq!(pack.short_name, "Custom_Name_1");
    }

    #[test]
    fn create_pack_rejects_invalid_input_without_leaving_a_trace() {
        let mut lib = Lib::new();
        assert!(lib.create("   ", None).is_err());
        assert!(lib.create(&"x".repeat(65), None).is_err());
        assert!(lib.create("Fine", Some("1bad")).is_err());
        assert!(lib.create("Fine", Some("a__b")).is_err());
        assert_eq!(lib.pack_count(), 0);
        let entries: Vec<_> = fs::read_dir(lib.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("pack_"))
            .collect();
        assert!(entries.is_empty(), "stray folders: {entries:?}");
    }

    #[test]
    fn create_pack_reuses_an_empty_orphan_folder() {
        // A crash before the create commit can leave an empty pack_<id>
        // folder behind (ADR-0004); the next create with that id adopts it.
        let mut lib = Lib::new();
        fs::create_dir(lib.path().join("pack_1")).unwrap();
        let pack = lib.create("First", None).unwrap();
        assert_eq!(pack.folder, "pack_1");
        assert!(lib.path().join("pack_1").is_dir());
    }

    #[test]
    fn create_pack_refuses_a_non_empty_folder_it_did_not_create() {
        let mut lib = Lib::new();
        fs::create_dir(lib.path().join("pack_1")).unwrap();
        fs::write(lib.path().join("pack_1").join("001.png"), "stranger").unwrap();
        let err = lib.create("First", None).unwrap_err();
        assert!(err.contains("pack_1"), "unexpected error: {err}");
        assert_eq!(lib.pack_count(), 0);
        assert_eq!(
            fs::read_to_string(lib.path().join("pack_1").join("001.png")).unwrap(),
            "stranger"
        );
    }

    #[test]
    fn pack_ids_and_folders_are_never_reused_after_delete() {
        let mut lib = Lib::new();
        lib.create("A", None).unwrap();
        let b = lib.create("B", None).unwrap();
        delete_pack(&lib.conn, lib.path(), b.id).unwrap();
        let c = lib.create("C", None).unwrap();
        assert!(c.id > b.id, "id {} reused", c.id);
        assert_ne!(c.folder, b.folder);
    }

    #[test]
    fn title_is_always_editable() {
        let mut lib = Lib::new();
        let pack = lib.create("Old", None).unwrap();
        let renamed = set_title(&lib.conn, pack.id, "  New Title ").unwrap();
        assert_eq!(renamed.title, "New Title");
        // Editing the Title never touches the Short Name or the folder.
        assert_eq!(renamed.short_name, "old");
        assert_eq!(renamed.folder, pack.folder);
        set_status(&lib.conn, pack.id, PackStatus::Live).unwrap();
        assert_eq!(set_title(&lib.conn, pack.id, "Live Title").unwrap().title, "Live Title");
        assert!(set_title(&lib.conn, pack.id, "").is_err());
        assert!(set_title(&lib.conn, 999, "Nope").is_err());
    }

    #[test]
    fn short_name_is_editable_only_while_draft() {
        let mut lib = Lib::new();
        let pack = lib.create("Pack", None).unwrap();
        assert_eq!(
            set_short_name(&lib.conn, pack.id, "renamed_1").unwrap().short_name,
            "renamed_1"
        );
        assert!(set_short_name(&lib.conn, pack.id, "bad name").is_err());
        set_status(&lib.conn, pack.id, PackStatus::Live).unwrap();
        let err = set_short_name(&lib.conn, pack.id, "other").unwrap_err();
        assert!(err.contains("Live"), "unexpected error: {err}");
        assert_eq!(load_pack(&lib.conn, pack.id).unwrap().short_name, "renamed_1");
        // Unlocked again after toggling back to Draft.
        set_status(&lib.conn, pack.id, PackStatus::Draft).unwrap();
        assert_eq!(set_short_name(&lib.conn, pack.id, "other").unwrap().short_name, "other");
        assert!(set_short_name(&lib.conn, 999, "nope").is_err());
    }

    #[test]
    fn status_toggles_both_ways() {
        let mut lib = Lib::new();
        let pack = lib.create("Pack", None).unwrap();
        assert_eq!(set_status(&lib.conn, pack.id, PackStatus::Live).unwrap().status, PackStatus::Live);
        assert_eq!(set_status(&lib.conn, pack.id, PackStatus::Draft).unwrap().status, PackStatus::Draft);
        assert!(set_status(&lib.conn, 999, PackStatus::Live).is_err());
    }

    #[test]
    fn delete_pack_removes_rows_and_folder_for_draft_and_live() {
        for status in [PackStatus::Draft, PackStatus::Live] {
            let mut lib = Lib::new();
            let pack = lib.create("Doomed", None).unwrap();
            set_status(&lib.conn, pack.id, status).unwrap();
            let dir = pack_dir(lib.path(), &pack);
            fs::write(dir.join("001.png"), "A").unwrap();
            lib.conn
                .execute(
                    "INSERT INTO stickers (pack_id, position, file_name, format)
                         VALUES (?1, 1, '001.png', 'png')",
                    params![pack.id],
                )
                .unwrap();
            assert_eq!(delete_pack(&lib.conn, lib.path(), pack.id).unwrap().map(|l| l.reason), None);
            assert!(load_pack(&lib.conn, pack.id).is_err());
            let stickers: i64 = lib
                .conn
                .query_row("SELECT COUNT(*) FROM stickers", [], |r| r.get(0))
                .unwrap();
            assert_eq!(stickers, 0, "stickers must cascade");
            assert!(!dir.exists());
            // The Library itself is untouched.
            crate::library::validate_intact(lib.path()).unwrap();
        }
    }

    #[test]
    fn delete_pack_tolerates_an_already_absent_folder() {
        let mut lib = Lib::new();
        let pack = lib.create("Gone", None).unwrap();
        fs::remove_dir(pack_dir(lib.path(), &pack)).unwrap();
        assert!(delete_pack(&lib.conn, lib.path(), pack.id).unwrap().is_none());
        assert!(load_pack(&lib.conn, pack.id).is_err());
    }

    #[test]
    fn delete_pack_of_unknown_id_is_an_error() {
        let lib = Lib::new();
        assert!(delete_pack(&lib.conn, lib.path(), 999).is_err());
    }

    #[test]
    fn delete_pack_refuses_a_folder_value_outside_the_pack_scheme() {
        // Defence in depth: a corrupted folder column ('', '..', a path)
        // must never turn into a recursive delete of the Library or beyond.
        for bad in ["", "..", ".", "../elsewhere", "pack_1/..", "pack_x", "library.db"] {
            let mut lib = Lib::new();
            let pack = lib.create("P", None).unwrap();
            lib.conn
                .execute("UPDATE packs SET folder = ?1 WHERE id = ?2", params![bad, pack.id])
                .unwrap();
            assert!(delete_pack(&lib.conn, lib.path(), pack.id).is_err(), "accepted {bad:?}");
            assert!(load_pack(&lib.conn, pack.id).is_ok(), "row deleted for {bad:?}");
            crate::library::validate_intact(lib.path()).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn delete_pack_reports_a_leftover_folder_after_committing() {
        use std::os::unix::fs::PermissionsExt;
        let mut lib = Lib::new();
        let pack = lib.create("Stuck", None).unwrap();
        let dir = pack_dir(lib.path(), &pack);
        fs::write(dir.join("001.png"), "A").unwrap();
        // A read-only folder: its files cannot be unlinked.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let outcome = delete_pack(&lib.conn, lib.path(), pack.id);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let leftover = outcome.unwrap().expect("leftover folder must be reported");
        assert_eq!(leftover.path, dir);
        assert!(!leftover.reason.is_empty());
        // The deletion itself committed: never a row pointing at nothing.
        assert!(load_pack(&lib.conn, pack.id).is_err());
    }
}

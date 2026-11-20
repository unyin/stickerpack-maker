//! Library lifecycle: fresh creation and intact-library validation.
//!
//! A Library is an app-managed folder containing the SQLite database
//! (`library.db`) and one folder per pack (SPEC §3). Pack folders are created
//! when packs are created (SPM-2/SPM-3); a fresh Library contains only the
//! database.
//!
//! v1 rules (SPEC §3): re-pointing expects an INTACT Library (database
//! included); a fresh Library can be created in a new or empty folder; there
//! is NO auto-migration and NO reconstruction of metadata from orphaned image
//! files. This module is free of Tauri types so it can be unit-tested.

pub mod packs;
pub mod schema;

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use crate::db;

/// Database file name inside the Library folder.
pub const DB_FILE_NAME: &str = "library.db";

pub fn db_path(library_dir: &Path) -> PathBuf {
    library_dir.join(DB_FILE_NAME)
}

/// Validate that `dir` is an intact Library: an existing folder containing
/// the database file with our bootstrap schema, identified by the
/// `meta.schema_kind` marker (table names alone are generic and could belong
/// to any app's database). Used before re-pointing and when reporting status.
pub fn validate_intact(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!("{} is not an existing folder", dir.display()));
    }
    let db_file = db_path(dir);
    if !db_file.is_file() {
        return Err(format!(
            "{} does not contain {DB_FILE_NAME}. Re-pointing expects an intact Library \
             (database included); reconstructing a Library from orphaned files is not supported.",
            dir.display()
        ));
    }
    let conn = db::open_readonly(&db_file)?;
    let bootstrap_present = db::table_exists(&conn, "schema_migrations")?
        && db::table_exists(&conn, "meta")?
        && db::meta_value(&conn, "schema_kind")?.as_deref() == Some(db::SCHEMA_KIND);
    if !bootstrap_present {
        return Err(format!(
            "{} contains a database, but it is not a Stickerpack Maker Library \
             (missing or unrecognized bootstrap schema)",
            db_file.display()
        ));
    }
    Ok(())
}

/// Create a fresh Library: folder + database + bootstrap migrations.
/// `dir` must not exist yet, or be an existing EMPTY folder.
pub fn create_fresh(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        if !dir.is_dir() {
            return Err(format!("{} is not a folder", dir.display()));
        }
        let mut entries =
            fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
        if entries.next().is_some() {
            return Err(format!(
                "{} is not empty. A fresh Library requires an empty folder; moving or \
                 reconstructing an existing Library is not supported in v1.",
                dir.display()
            ));
        }
    } else {
        fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    db::create_and_migrate(&db_path(dir))
}

/// Open an existing Library for read-write use. Validates intactness first,
/// enables foreign keys (cascade deletes), and does NOT migrate: v1 has no
/// auto-migration (SPEC §3) — a Library is created with the current schema.
pub fn open(library_dir: &Path) -> Result<Connection, String> {
    validate_intact(library_dir)?;
    let conn = Connection::open_with_flags(db_path(library_dir), OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("cannot open database {}: {e}", db_path(library_dir).display()))?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .map_err(|e| format!("cannot configure database connection: {e}"))?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_returns_writable_connection_with_foreign_keys_on() {
        let root = tempfile::tempdir().unwrap();
        create_fresh(root.path()).unwrap();
        let conn = open(root.path()).unwrap();
        conn.execute_batch(
            "INSERT INTO packs (id, title, short_name, folder) VALUES (1, 'T', 't', 'pack_1');
             INSERT INTO stickers (pack_id, position, file_name, format)
                 VALUES (1, 1, '001.png', 'png');",
        )
        .unwrap();
        // Deleting a pack cascades to its stickers only with foreign_keys ON.
        conn.execute("DELETE FROM packs WHERE id = 1", []).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM stickers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn open_rejects_folder_without_library() {
        let root = tempfile::tempdir().unwrap();
        assert!(open(root.path()).is_err());
    }

    #[test]
    fn fresh_library_in_new_folder() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("Stickerpack Library");
        create_fresh(&dir).unwrap();
        assert!(db_path(&dir).is_file());
        validate_intact(&dir).unwrap();
    }

    #[test]
    fn fresh_library_in_existing_empty_folder() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("empty");
        fs::create_dir(&dir).unwrap();
        create_fresh(&dir).unwrap();
        validate_intact(&dir).unwrap();
    }

    #[test]
    fn fresh_library_refuses_non_empty_folder() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("orphan.png"), b"not a real image").unwrap();
        let err = create_fresh(root.path()).unwrap_err();
        assert!(err.contains("not empty"));
        assert!(!db_path(root.path()).exists());
    }

    #[test]
    fn fresh_library_refuses_existing_library() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("lib");
        create_fresh(&dir).unwrap();
        assert!(create_fresh(&dir).is_err());
    }

    #[test]
    fn validate_rejects_folder_without_database() {
        let root = tempfile::tempdir().unwrap();
        let err = validate_intact(root.path()).unwrap_err();
        assert!(err.contains(DB_FILE_NAME));
    }

    #[test]
    fn validate_rejects_missing_folder() {
        let root = tempfile::tempdir().unwrap();
        assert!(validate_intact(&root.path().join("nope")).is_err());
    }

    #[test]
    fn validate_rejects_foreign_database() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("foreign");
        fs::create_dir(&dir).unwrap();
        // A valid SQLite database that is not one of our Libraries.
        let conn = rusqlite::Connection::open(db_path(&dir)).unwrap();
        conn.execute_batch("CREATE TABLE something_else (id INTEGER);")
            .unwrap();
        drop(conn);
        let err = validate_intact(&dir).unwrap_err();
        assert!(err.contains("not a Stickerpack Maker Library"));
    }

    #[test]
    fn validate_rejects_foreign_database_with_generic_tables() {
        // A foreign SQLite DB that happens to use our table names but lacks
        // the schema_kind marker (or carries a different one) is NOT a Library.
        for marker_sql in [
            "",
            "INSERT INTO meta (key, value) VALUES ('schema_kind', 'some-other-app');",
        ] {
            let root = tempfile::tempdir().unwrap();
            let dir = root.path().join("foreign-generic");
            fs::create_dir(&dir).unwrap();
            let conn = rusqlite::Connection::open(db_path(&dir)).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                 CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
                 {marker_sql}"
            ))
            .unwrap();
            drop(conn);
            let err = validate_intact(&dir).unwrap_err();
            assert!(err.contains("not a Stickerpack Maker Library"));
        }
    }

    #[test]
    fn validate_rejects_garbage_database_file() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("garbage");
        fs::create_dir(&dir).unwrap();
        fs::write(db_path(&dir), b"this is not sqlite").unwrap();
        assert!(validate_intact(&dir).is_err());
    }
}
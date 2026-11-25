//! SQLite access and the migrations runner.
//!
//! The runner maintains `schema_migrations` and applies the embedded SQL
//! files from `src-tauri/migrations` in order, once each: 0001 bootstraps
//! the meta table (SPM-1), 0002 adds the domain schema (SPM-2), 0003 the
//! Pack list's stored display order (SPM-25).

use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

/// Marker value the bootstrap migration writes to `meta.schema_kind`;
/// identifies a database as one of our Libraries (must match 0001_init.sql).
pub const SCHEMA_KIND: &str = "stickerpack-library";

/// Embedded migrations, applied in order. Version = index + 1.
/// Add new entries here (plus the matching .sql file) as the schema grows;
/// never edit an already-shipped migration.
const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("../migrations/0001_init.sql")),
    ("0002_domain", include_str!("../migrations/0002_domain.sql")),
    ("0003_pack_order", include_str!("../migrations/0003_pack_order.sql")),
];

/// Create the database file (and parent folders) and apply pending migrations.
pub fn create_and_migrate(db_file: &Path) -> Result<(), String> {
    if let Some(parent) = db_file.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!("cannot create database folder {}: {e}", parent.display())
        })?;
    }
    let mut conn = Connection::open(db_file)
        .map_err(|e| format!("cannot create database {}: {e}", db_file.display()))?;
    migrate(&mut conn)
}

/// Open an existing database read-only (used to validate an intact Library).
pub fn open_readonly(db_file: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(db_file, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("cannot open database {}: {e}", db_file.display()))
}

/// Apply pending migrations inside one transaction. Idempotent.
pub fn migrate(conn: &mut Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version    INTEGER PRIMARY KEY,
             name       TEXT NOT NULL,
             applied_at TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )
    .map_err(|e| format!("cannot create schema_migrations: {e}"))?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("cannot start migration transaction: {e}"))?;
    for (index, (name, sql)) in MIGRATIONS.iter().enumerate() {
        let version = index as i64 + 1;
        let already_applied = tx
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = ?1",
                params![version],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| format!("cannot read schema_migrations: {e}"))?
            .is_some();
        if already_applied {
            continue;
        }
        tx.execute_batch(sql)
            .map_err(|e| format!("migration {name} failed: {e}"))?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
            params![version, name],
        )
        .map_err(|e| format!("cannot record migration {name}: {e}"))?;
    }
    tx.commit()
        .map_err(|e| format!("cannot commit migrations: {e}"))?;
    Ok(())
}

/// True when every embedded migration has been applied to `conn`. A
/// database from a newer build (more migrations than this one knows) also
/// counts as current: it is left alone.
///
/// Why it exists: `library::open` runs on every command, and checking first
/// avoids starting a migration transaction on each call. `MAX(version) >= len`
/// is sufficient because versions are only inserted by `migrate`, in order,
/// inside one transaction, so a database never has gaps.
pub fn is_current(conn: &Connection) -> Result<bool, String> {
    let applied: i64 = conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |r| r.get(0))
        .map_err(|e| format!("cannot read schema_migrations: {e}"))?;
    Ok(applied >= MIGRATIONS.len() as i64)
}

/// True when `conn` has a table with the given name.
pub fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    let found = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("cannot inspect database schema: {e}"))?;
    Ok(found.is_some())
}

/// Value of a `meta` key, or None when the key is absent.
pub fn meta_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| format!("cannot read meta table: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_creates_bootstrap_schema() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        assert!(table_exists(&conn, "schema_migrations").unwrap());
        assert!(table_exists(&conn, "meta").unwrap());
        let kind: String = conn
            .query_row("SELECT value FROM meta WHERE key = 'schema_kind'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kind, "stickerpack-library");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, MIGRATIONS.len() as i64);
    }

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, MIGRATIONS.len() as i64);
    }

    #[test]
    fn migrate_creates_domain_schema() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        for table in ["packs", "stickers", "rename_journal"] {
            assert!(table_exists(&conn, table).unwrap(), "missing table {table}");
        }
        conn.execute_batch(
            "INSERT INTO packs (id, title, short_name) VALUES (1, 'T', 't');
             INSERT INTO stickers (pack_id, position, file_name, format)
                 VALUES (1, 1, '001.png', 'png'), (1, 2, '002.png', 'png');",
        )
        .unwrap();
        // Positions and file names are unique per pack, enforced immediately
        // (SQLite cannot defer composite UNIQUE constraints).
        assert!(conn
            .execute(
                "INSERT INTO stickers (pack_id, position, file_name, format)
                     VALUES (1, 1, '003.png', 'png')",
                [],
            )
            .is_err());
        // A renumber therefore vacates the position/name space first, then
        // assigns finals — all inside one transaction (ADR-0004).
        let tx = conn.transaction().unwrap();
        tx.execute_batch(
            "UPDATE stickers SET position = position + 1000000, file_name = '.dbtmp-' || id
                 WHERE pack_id = 1;
             UPDATE stickers SET position = 2, file_name = '002.png' WHERE id = 1;
             UPDATE stickers SET position = 1, file_name = '001.png' WHERE id = 2;",
        )
        .unwrap();
        tx.commit().unwrap();
        let pos: i64 = conn
            .query_row("SELECT position FROM stickers WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pos, 2);
        // format and status are constrained to the SPEC vocabulary.
        assert!(conn
            .execute(
                "INSERT INTO stickers (pack_id, position, file_name, format)
                     VALUES (1, 3, '003.gif', 'gif')",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO packs (id, title, short_name, status)
                     VALUES (2, 'T', 'u', 'published')",
                [],
            )
            .is_err());
        // Short Names name the pack folders: unique, case-insensitively.
        assert!(conn
            .execute("INSERT INTO packs (id, title, short_name) VALUES (3, 'T', 'T')", [])
            .is_err());
    }

    #[test]
    fn create_and_migrate_creates_file_and_parent_folders() {
        let dir = tempfile::tempdir().unwrap();
        let db_file = dir.path().join("nested").join("library.db");
        create_and_migrate(&db_file).unwrap();
        assert!(db_file.is_file());
        let conn = open_readonly(&db_file).unwrap();
        assert!(table_exists(&conn, "meta").unwrap());
    }
}
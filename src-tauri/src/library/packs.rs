//! Pack operations and Title / Short Name validation (SPEC §3, §7).
//!
//! A pack's folder inside the Library is named after its Short Name (owner
//! decision 2026-11-20), so Short Names are unique within the Library,
//! case-insensitively, and never a Windows reserved device name. Folder
//! changes follow ADR-0004's commit-first ordering: creation commits only
//! once the folder exists; deletion commits the row removal before touching
//! the folder; a Draft Short Name edit commits the new name plus a
//! `folder_rename_from` marker, then renames the folder, then clears the
//! marker — `settle_pack_folder` rolls an interrupted rename forward.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::files;
use super::schema::{load_pack, load_packs, Pack, PackStatus};
use crate::limits::{SHORT_NAME_MAX_CHARS, TITLE_MAX_CHARS};

/// Folder of `pack` inside the Library: named after its Short Name. While a
/// folder rename is pending, the folder may still sit under the old name;
/// call `settle_pack_folder` before touching files.
pub fn pack_dir(library_dir: &Path, pack: &Pack) -> PathBuf {
    library_dir.join(&pack.short_name)
}

/// True when the Library already holds a pack with this Short Name,
/// other than `except`. Both the Short Name and a pending rename's old name
/// compare case-insensitively (`COLLATE NOCASE`), because folder names are
/// case-insensitive on NTFS. A pending folder rename's old
/// name counts as taken too: its folder still holds that pack's files, and a
/// new pack adopting it would be wiped by the other pack's deletion.
fn short_name_taken(conn: &Connection, short_name: &str, except: Option<i64>) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM packs
             WHERE (short_name = ?1 COLLATE NOCASE OR folder_rename_from = ?1 COLLATE NOCASE) AND id IS NOT ?2",
        params![short_name, except],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(|e| format!("cannot check Short Name uniqueness: {e}"))
}

fn short_name_in_use(short_name: &str) -> String {
    format!("Short Name {short_name:?} is already used by another pack in this Library")
}

/// True when `dir` is absent or an empty folder — free for a pack to use.
fn folder_is_free(dir: &Path) -> Result<bool, String> {
    if !dir.exists() {
        return Ok(true);
    }
    Ok(dir.is_dir()
        && fs::read_dir(dir)
            .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
            .next()
            .is_none())
}

fn folder_occupied(dir: &Path) -> String {
    format!(
        "{} already exists and is not an empty folder; it does not belong to this pack, \
         so move or remove it first",
        dir.display()
    )
}

/// `base` with a numeric suffix (`cats_2`), shortened so the result stays
/// within the Short Name limit without a trailing or doubled underscore.
fn with_suffix(base: &str, n: u32) -> String {
    let suffix = format!("_{n}");
    let keep: String = base.chars().take(SHORT_NAME_MAX_CHARS - suffix.len()).collect();
    format!("{}{suffix}", keep.trim_end_matches('_'))
}

/// First free Short Name for an auto-derived `base`: `base`, `base_2`,
/// `base_3`, … skipping names used by a pack or by a non-empty folder.
fn unique_auto_short_name(conn: &Connection, library_dir: &Path, base: &str) -> Result<String, String> {
    for n in 1..=10_000 {
        let candidate = if n == 1 { base.to_string() } else { with_suffix(base, n) };
        if !short_name_taken(conn, &candidate, None)? && folder_is_free(&library_dir.join(&candidate))? {
            return Ok(candidate);
        }
    }
    Err(format!("cannot find a free Short Name derived from {base:?}"))
}

/// The Short Name `create_pack` would auto-derive for `title` right now:
/// the create dialog's live preview (SPEC §5). Not reserved — another pack
/// may take it first, and creation derives it again.
pub fn suggest_short_name(conn: &Connection, library_dir: &Path, title: &str) -> Result<String, String> {
    unique_auto_short_name(conn, library_dir, &auto_short_name(title.trim()))
}

/// A pack as the pack list shows it: the row plus its sticker count, read
/// from the database only (no file checks: desync detection runs on pack
/// open and refresh, never on the list or at app start, SPEC §4).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSummary {
    #[serde(flatten)]
    pub pack: Pack,
    pub sticker_count: i64,
}

/// Every pack in creation order, with its sticker count (one grouped query).
pub fn pack_summaries(conn: &Connection) -> Result<Vec<PackSummary>, String> {
    let mut stmt = conn
        .prepare("SELECT pack_id, COUNT(*) FROM stickers GROUP BY pack_id")
        .map_err(|e| format!("cannot count stickers: {e}"))?;
    let counts: std::collections::HashMap<i64, i64> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| format!("cannot count stickers: {e}"))?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| format!("cannot count stickers: {e}"))?;
    Ok(load_packs(conn)?
        .into_iter()
        .map(|pack| PackSummary { sticker_count: counts.get(&pack.id).copied().unwrap_or(0), pack })
        .collect())
}

/// Create a pack (Draft, SPEC §3). A given `short_name` is validated and
/// must be unused; otherwise one is auto-derived from the Title and made
/// unique with a numeric suffix. The folder is created inside the
/// transaction, before commit, so a committed pack always has its folder
/// (ADR-0004). An existing EMPTY folder of that name is a harmless orphan
/// and is adopted; a non-empty one does not belong to this pack and is
/// refused rather than silently absorbed.
pub fn create_pack(
    conn: &mut Connection,
    library_dir: &Path,
    title: &str,
    short_name: Option<&str>,
) -> Result<Pack, String> {
    let title = validate_title(title)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("cannot start transaction: {e}"))?;
    let short_name = match short_name {
        Some(given) => {
            validate_short_name(given)?;
            if short_name_taken(&tx, given, None)? {
                return Err(short_name_in_use(given));
            }
            given.to_string()
        }
        None => unique_auto_short_name(&tx, library_dir, &auto_short_name(&title))?,
    };
    tx.execute(
        "INSERT INTO packs (title, short_name) VALUES (?1, ?2)",
        params![title, short_name],
    )
    .map_err(|e| format!("cannot create pack: {e}"))?;
    let pack_id = tx.last_insert_rowid();

    let dir = library_dir.join(&short_name);
    if !folder_is_free(&dir)? {
        return Err(format!("cannot create pack: {}", folder_occupied(&dir)));
    }
    let created_dir = !dir.exists();
    if created_dir {
        fs::create_dir(&dir)
            .map_err(|e| format!("cannot create pack folder {}: {e}", dir.display()))?;
    }
    if let Err(e) = tx.commit() {
        // Not committed: undo the empty folder we just made (best effort;
        // if this fails too it is the accepted empty orphan, ADR-0004).
        if created_dir {
            let _ = fs::remove_dir(&dir);
        }
        return Err(format!("cannot commit new pack: {e}"));
    }
    load_pack(conn, pack_id)
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

/// True when `dir` holds an entry named exactly `name` (case-sensitive
/// match, even on case-insensitive filesystems where `exists()` is not).
fn has_exact_entry(dir: &Path, name: &str) -> Result<bool, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
        if entry.file_name() == name {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Edit a pack's Short Name; Draft only — locked once Live because Telegram
/// short names are immutable after creation (SPEC §3). Renames the pack
/// folder to match, commit-first: if the rename cannot happen now (e.g. the
/// folder is open in Explorer), the edit still stands and the returned pack
/// carries `folder_rename_from`; `settle_pack_folder` retries it.
pub fn set_short_name(
    conn: &Connection,
    library_dir: &Path,
    pack_id: i64,
    short_name: &str,
) -> Result<Pack, String> {
    validate_short_name(short_name)?;
    let pack = settle_pack_folder(conn, library_dir, pack_id)?;
    if pack.status == PackStatus::Live {
        return Err(
            "Short Name is locked while the pack is Live (Telegram short names cannot change)"
                .to_string(),
        );
    }
    // (A still-blocked earlier rename already failed `settle_pack_folder`.)
    if pack.short_name == short_name {
        return Ok(pack);
    }
    if short_name_taken(conn, short_name, Some(pack_id))? {
        return Err(short_name_in_use(short_name));
    }
    // A case-only change keeps the same folder (NTFS is case-insensitive);
    // otherwise the destination must be free. An empty orphan is cleared
    // so the rename can land (Windows cannot rename onto an existing dir).
    let dest = library_dir.join(short_name);
    if !pack.short_name.eq_ignore_ascii_case(short_name) && dest.exists() {
        if !folder_is_free(&dest)? {
            return Err(format!("cannot change Short Name: {}", folder_occupied(&dest)));
        }
        fs::remove_dir(&dest)
            .map_err(|e| format!("cannot clear empty folder {}: {e}", dest.display()))?;
    }
    conn.execute(
        "UPDATE packs SET short_name = ?1, folder_rename_from = ?2 WHERE id = ?3",
        params![short_name, pack.short_name, pack_id],
    )
    .map_err(|e| format!("cannot update pack {pack_id}: {e}"))?;
    // Committed: from here the rename is roll-forward. A failure now leaves
    // the marker pending instead of failing the edit.
    match settle_pack_folder(conn, library_dir, pack_id) {
        Ok(settled) => Ok(settled),
        Err(_) => load_pack(conn, pack_id),
    }
}

/// Complete a pending folder rename (left by an interrupted or blocked
/// Short Name edit) and return the settled pack. Idempotent; runs on pack
/// open/refresh and before any operation touching the pack's files.
/// Errors when the rename still cannot happen, or when both folders exist
/// (modified outside the app — never guessed).
pub fn settle_pack_folder(conn: &Connection, library_dir: &Path, pack_id: i64) -> Result<Pack, String> {
    let pack = load_pack(conn, pack_id)?;
    let Some(old) = pack.folder_rename_from.clone() else {
        return Ok(pack);
    };
    let old_present = has_exact_entry(library_dir, &old)?;
    let new_present = has_exact_entry(library_dir, &pack.short_name)?;
    let new_dir = pack_dir(library_dir, &pack);
    match (old_present, new_present) {
        (true, true) => {
            return Err(format!(
                "both {} and {} exist; the Library was modified outside the app",
                library_dir.join(&old).display(),
                new_dir.display()
            ))
        }
        (true, false) => fs::rename(library_dir.join(&old), &new_dir).map_err(|e| {
            format!(
                "cannot rename pack folder {} to {}: {e}; close any window using it and refresh",
                library_dir.join(&old).display(),
                new_dir.display()
            )
        })?,
        // Already renamed (crash before the marker was cleared), or the
        // folder vanished externally — desync detection reports Missing.
        (false, _) => {}
    }
    conn.execute(
        "UPDATE packs SET folder_rename_from = NULL WHERE id = ?1",
        params![pack_id],
    )
    .map_err(|e| format!("cannot clear folder rename of pack {pack_id}: {e}"))?;
    load_pack(conn, pack_id)
}

/// Bring a pack's folder up to date before touching its files: finish a
/// pending folder rename, recreate the folder if it was deleted outside the
/// app (its stickers then read as Missing and can be replaced), then roll
/// forward a pending rename plan and sweep stray pre-commit temps. Shared by
/// the sticker operations and desync detection.
pub(super) fn open_pack_files(conn: &Connection, library_dir: &Path, pack_id: i64) -> Result<(Pack, PathBuf), String> {
    let pack = settle_pack_folder(conn, library_dir, pack_id)?;
    let dir = pack_dir(library_dir, &pack);
    if !dir.exists() {
        fs::create_dir(&dir).map_err(|e| format!("cannot recreate pack folder {}: {e}", dir.display()))?;
    }
    files::recover(conn, &dir, pack_id)?;
    Ok((pack, dir))
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
/// (cascading stickers and journal) commits, THEN the folder is removed —
/// under both names if a rename was pending. `Ok(Some(leftover))` means the
/// pack is gone from the Library but a folder could not be removed —
/// reported, never a row pointing at nothing.
pub fn delete_pack(
    conn: &Connection,
    library_dir: &Path,
    pack_id: i64,
) -> Result<Option<LeftoverFolder>, String> {
    let pack = load_pack(conn, pack_id)?;
    // Guard every recursive delete: only names that pass Short Name
    // validation (no separators, dots, or reserved names) are folder names,
    // so a corrupted row can never resolve to the Library or beyond.
    let mut folders = vec![pack.short_name.clone()];
    folders.extend(pack.folder_rename_from.clone());
    for folder in &folders {
        if validate_short_name(folder).is_err() {
            return Err(format!(
                "refusing to delete pack {pack_id}: {folder:?} is not a valid pack folder name"
            ));
        }
    }
    conn.execute("DELETE FROM packs WHERE id = ?1", params![pack_id])
        .map_err(|e| format!("cannot delete pack {pack_id}: {e}"))?;
    let mut leftover = None;
    for folder in folders {
        let dir = library_dir.join(folder);
        match fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                leftover.get_or_insert(LeftoverFolder { path: dir, reason: e.to_string() });
            }
        }
    }
    Ok(leftover)
}

/// Validate a Title: free text, 1–`TITLE_MAX_CHARS` characters after trimming (SPEC §7).
/// Returns the trimmed Title to store.
pub fn validate_title(title: &str) -> Result<String, String> {
    let trimmed = title.trim();
    let len = trimmed.chars().count();
    if len == 0 || len > TITLE_MAX_CHARS {
        return Err(format!(
            "Title must be 1–{TITLE_MAX_CHARS} characters (got {len}); a Title is always required"
        ));
    }
    Ok(trimmed.to_string())
}

/// Validate a Short Name against Telegram's slug rules (SPEC §3/§7):
/// letters/digits/underscores, begins with a letter, no consecutive
/// underscores, at most `SHORT_NAME_MAX_CHARS` characters. Enforced in the core, not just the UI.
pub fn validate_short_name(short_name: &str) -> Result<(), String> {
    if short_name.is_empty() {
        return Err("Short Name must not be empty".to_string());
    }
    if short_name.chars().count() > SHORT_NAME_MAX_CHARS {
        return Err(format!("Short Name must be at most {SHORT_NAME_MAX_CHARS} characters"));
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
    if is_windows_reserved(short_name) {
        return Err(format!(
            "Short Name {short_name:?} is a name Windows reserves and cannot be a pack folder"
        ));
    }
    Ok(())
}

/// Windows reserved device names (case-insensitive): CON, PRN, AUX, NUL,
/// COM0–COM9, LPT0–LPT9. Valid on Telegram, but no folder can carry them,
/// and the pack folder is named after the Short Name.
fn is_windows_reserved(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "con" | "prn" | "aux" | "nul" => true,
        _ => {
            lower.len() == 4
                && (lower.starts_with("com") || lower.starts_with("lpt"))
                && lower.as_bytes()[3].is_ascii_digit()
        }
    }
}

/// Auto-derive a Short Name from a Title (SPEC §3): lowercase, runs of
/// non-alphanumeric characters collapse to a single underscore, no leading
/// or trailing underscore. Titles without letters get a `pack` prefix so the
/// result always begins with a letter; the result is truncated to `SHORT_NAME_MAX_CHARS`
/// characters and always passes `validate_short_name` (a Windows reserved
/// result gets a `_pack` suffix). Uniqueness is `create_pack`'s job.
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
    // Truncate to the limit; a trailing underscore from the cut is trimmed.
    // The construction never produces consecutive underscores.
    let truncated: String = out.chars().take(SHORT_NAME_MAX_CHARS).collect();
    let short = truncated.trim_end_matches('_').to_string();
    if is_windows_reserved(&short) {
        format!("{short}_pack")
    } else {
        short
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_name_accepts_telegram_slugs() {
        for good in ["a", "abc", "A_1", "My_Pack_2", &"x".repeat(SHORT_NAME_MAX_CHARS)] {
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
            &"x".repeat(SHORT_NAME_MAX_CHARS + 1), // too long
        ] {
            assert!(validate_short_name(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn title_is_trimmed_and_length_checked() {
        assert_eq!(validate_title("  My Pack  ").unwrap(), "My Pack");
        assert!(validate_title("").is_err());
        assert!(validate_title("   ").is_err());
        assert!(validate_title(&"x".repeat(TITLE_MAX_CHARS)).is_ok());
        assert!(validate_title(&"x".repeat(TITLE_MAX_CHARS + 1)).is_err());
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
            assert!(short.chars().count() <= SHORT_NAME_MAX_CHARS);
        }
    }

    #[test]
    fn short_name_rejects_windows_reserved_names() {
        for reserved in ["con", "CON", "Prn", "aux", "nul", "com0", "COM1", "com9", "lpt0", "LPT9"] {
            let err = validate_short_name(reserved).unwrap_err();
            assert!(err.contains("Windows"), "{reserved:?}: {err}");
        }
        // Only the exact device names are reserved.
        for fine in ["con_pack", "console", "com10", "lpt", "comx", "nul1"] {
            assert!(validate_short_name(fine).is_ok(), "rejected {fine:?}");
        }
    }

    #[test]
    fn auto_short_name_sidesteps_reserved_names() {
        assert_eq!(auto_short_name("Con"), "con_pack");
        assert_eq!(auto_short_name("LPT1!"), "lpt1_pack");
        assert_eq!(auto_short_name("Cons"), "cons");
    }

    #[test]
    fn numeric_suffix_respects_the_length_limit() {
        assert_eq!(with_suffix("cats", 2), "cats_2");
        let long = "x".repeat(SHORT_NAME_MAX_CHARS);
        let suffixed = with_suffix(&long, 12);
        assert_eq!(suffixed.chars().count(), SHORT_NAME_MAX_CHARS);
        assert!(suffixed.ends_with("_12"));
        // A cut that lands on an underscore never yields "__".
        let underscored = format!("{}_y", "x".repeat(SHORT_NAME_MAX_CHARS - 3));
        assert!(validate_short_name(&with_suffix(&underscored, 2)).is_ok());
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

        fn rename(&self, pack_id: i64, short_name: &str) -> Result<Pack, String> {
            set_short_name(&self.conn, self.dir.path(), pack_id, short_name)
        }

        fn pack_count(&self) -> i64 {
            self.conn
                .query_row("SELECT COUNT(*) FROM packs", [], |r| r.get(0))
                .unwrap()
        }

        /// Library entries other than the database, sorted.
        fn folders(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(self.path())
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|n| !n.starts_with(crate::library::DB_FILE_NAME))
                .collect();
            names.sort();
            names
        }
    }

    #[test]
    fn suggested_short_name_matches_what_creation_derives() {
        let mut lib = Lib::new();
        assert_eq!(suggest_short_name(&lib.conn, lib.path(), "  Cats!  ").unwrap(), "cats");
        lib.create("Cats", None).unwrap();
        assert_eq!(suggest_short_name(&lib.conn, lib.path(), "Cats").unwrap(), "cats_2");
        assert_eq!(lib.create("Cats", None).unwrap().short_name, "cats_2");
        assert_eq!(suggest_short_name(&lib.conn, lib.path(), "").unwrap(), "pack");
        assert_eq!(suggest_short_name(&lib.conn, lib.path(), "con").unwrap(), "con_pack");
        // A non-empty foreign folder is skipped, like creation does.
        fs::create_dir(lib.path().join("dogs")).unwrap();
        fs::write(lib.path().join("dogs").join("x.png"), "x").unwrap();
        assert_eq!(suggest_short_name(&lib.conn, lib.path(), "Dogs").unwrap(), "dogs_2");
    }

    #[test]
    fn summaries_list_packs_in_creation_order_with_sticker_counts() {
        let mut lib = Lib::new();
        let a = lib.create("A", None).unwrap();
        let b = lib.create("B", None).unwrap();
        lib.conn
            .execute_batch(&format!(
                "INSERT INTO stickers (pack_id, position, file_name, format) VALUES
                     ({0}, 1, '001.png', 'png'), ({0}, 2, '002.png', 'png');",
                b.id
            ))
            .unwrap();
        let list = pack_summaries(&lib.conn).unwrap();
        assert_eq!(list.iter().map(|p| (p.pack.id, p.sticker_count)).collect::<Vec<_>>(), [(a.id, 0), (b.id, 2)]);
        let json = serde_json::to_value(&list[1]).unwrap();
        assert_eq!(json["shortName"], "b");
        assert_eq!(json["stickerCount"], 2);
    }

    #[test]
    fn create_pack_is_draft_with_auto_short_name_and_a_folder_named_after_it() {
        let mut lib = Lib::new();
        let pack = lib.create("  My Cool Pack!  ", None).unwrap();
        assert_eq!(pack.title, "My Cool Pack!");
        assert_eq!(pack.short_name, "my_cool_pack");
        assert_eq!(pack.status, PackStatus::Draft);
        assert_eq!(pack.thumbnail, None);
        assert_eq!(pack.folder_rename_from, None);
        assert_eq!(pack_dir(lib.path(), &pack), lib.path().join("my_cool_pack"));
        assert!(pack_dir(lib.path(), &pack).is_dir());
        assert_eq!(load_pack(&lib.conn, pack.id).unwrap().short_name, "my_cool_pack");
    }

    #[test]
    fn create_pack_accepts_a_valid_explicit_short_name() {
        let mut lib = Lib::new();
        let pack = lib.create("Title", Some("Custom_Name_1")).unwrap();
        assert_eq!(pack.short_name, "Custom_Name_1");
        assert!(lib.path().join("Custom_Name_1").is_dir());
    }

    #[test]
    fn create_pack_rejects_invalid_input_without_leaving_a_trace() {
        let mut lib = Lib::new();
        assert!(lib.create("   ", None).is_err());
        assert!(lib.create(&"x".repeat(TITLE_MAX_CHARS + 1), None).is_err());
        assert!(lib.create("Fine", Some("1bad")).is_err());
        assert!(lib.create("Fine", Some("a__b")).is_err());
        assert!(lib.create("Fine", Some("nul")).is_err());
        assert_eq!(lib.pack_count(), 0);
        assert!(lib.folders().is_empty(), "stray folders: {:?}", lib.folders());
    }

    #[test]
    fn auto_short_names_get_a_numeric_suffix_when_taken() {
        let mut lib = Lib::new();
        assert_eq!(lib.create("Cats", None).unwrap().short_name, "cats");
        assert_eq!(lib.create("Cats", None).unwrap().short_name, "cats_2");
        assert_eq!(lib.create("CATS!", None).unwrap().short_name, "cats_3");
        assert_eq!(lib.folders(), vec!["cats", "cats_2", "cats_3"]);
    }

    #[test]
    fn auto_short_name_skips_a_non_empty_leftover_folder() {
        // E.g. a folder left behind by a delete that could not remove it.
        let mut lib = Lib::new();
        fs::create_dir(lib.path().join("cats")).unwrap();
        fs::write(lib.path().join("cats").join("001.png"), "old").unwrap();
        assert_eq!(lib.create("Cats", None).unwrap().short_name, "cats_2");
        assert_eq!(fs::read_to_string(lib.path().join("cats").join("001.png")).unwrap(), "old");
    }

    #[test]
    fn explicit_short_name_already_used_is_refused_case_insensitively() {
        let mut lib = Lib::new();
        lib.create("Cats", Some("cats")).unwrap();
        for taken in ["cats", "CATS", "Cats"] {
            let err = lib.create("Other", Some(taken)).unwrap_err();
            assert!(err.contains("already used"), "{taken:?}: {err}");
        }
        assert_eq!(lib.pack_count(), 1);
    }

    #[test]
    fn create_pack_reuses_an_empty_orphan_folder() {
        // A crash before the create commit can leave an empty folder behind
        // (ADR-0004); the next create with that Short Name adopts it.
        let mut lib = Lib::new();
        fs::create_dir(lib.path().join("first")).unwrap();
        let pack = lib.create("First", None).unwrap();
        assert_eq!(pack.short_name, "first");
        assert_eq!(lib.folders(), vec!["first"]);
    }

    #[test]
    fn create_pack_refuses_an_explicit_name_whose_folder_is_not_empty() {
        let mut lib = Lib::new();
        fs::create_dir(lib.path().join("first")).unwrap();
        fs::write(lib.path().join("first").join("001.png"), "stranger").unwrap();
        let err = lib.create("First", Some("first")).unwrap_err();
        assert!(err.contains("first"), "unexpected error: {err}");
        assert_eq!(lib.pack_count(), 0);
        assert_eq!(
            fs::read_to_string(lib.path().join("first").join("001.png")).unwrap(),
            "stranger"
        );
    }

    #[test]
    fn title_is_always_editable() {
        let mut lib = Lib::new();
        let pack = lib.create("Old", None).unwrap();
        let renamed = set_title(&lib.conn, pack.id, "  New Title ").unwrap();
        assert_eq!(renamed.title, "New Title");
        // Editing the Title never touches the Short Name or the folder.
        assert_eq!(renamed.short_name, "old");
        assert_eq!(lib.folders(), vec!["old"]);
        set_status(&lib.conn, pack.id, PackStatus::Live).unwrap();
        assert_eq!(set_title(&lib.conn, pack.id, "Live Title").unwrap().title, "Live Title");
        assert!(set_title(&lib.conn, pack.id, "").is_err());
        assert!(set_title(&lib.conn, 999, "Nope").is_err());
    }

    #[test]
    fn short_name_edit_renames_the_folder_with_its_files() {
        let mut lib = Lib::new();
        let pack = lib.create("Pack", None).unwrap();
        fs::write(pack_dir(lib.path(), &pack).join("001.png"), "A").unwrap();
        let renamed = lib.rename(pack.id, "renamed_1").unwrap();
        assert_eq!(renamed.short_name, "renamed_1");
        assert_eq!(renamed.folder_rename_from, None);
        assert_eq!(lib.folders(), vec!["renamed_1"]);
        assert_eq!(
            fs::read_to_string(lib.path().join("renamed_1").join("001.png")).unwrap(),
            "A"
        );
        // Unchanged name is a no-op.
        assert_eq!(lib.rename(pack.id, "renamed_1").unwrap().short_name, "renamed_1");
    }

    #[test]
    fn short_name_case_only_edit_renames_the_folder() {
        let mut lib = Lib::new();
        let pack = lib.create("Pack", Some("my_pack")).unwrap();
        assert_eq!(lib.rename(pack.id, "My_Pack").unwrap().short_name, "My_Pack");
        assert_eq!(lib.folders(), vec!["My_Pack"]);
    }

    #[test]
    fn short_name_edit_is_refused_when_invalid_or_taken() {
        let mut lib = Lib::new();
        let a = lib.create("A", Some("alpha")).unwrap();
        lib.create("B", Some("beta")).unwrap();
        assert!(lib.rename(a.id, "bad name").is_err());
        assert!(lib.rename(a.id, "aux").is_err());
        let err = lib.rename(a.id, "BETA").unwrap_err();
        assert!(err.contains("already used"), "unexpected error: {err}");
        fs::create_dir(lib.path().join("gamma")).unwrap();
        fs::write(lib.path().join("gamma").join("x.png"), "x").unwrap();
        assert!(lib.rename(a.id, "gamma").is_err());
        assert!(lib.rename(999, "nope").is_err());
        assert_eq!(load_pack(&lib.conn, a.id).unwrap().short_name, "alpha");
        assert!(lib.path().join("alpha").is_dir());
    }

    #[test]
    fn short_name_edit_can_land_on_an_empty_orphan_folder() {
        let mut lib = Lib::new();
        let pack = lib.create("A", Some("alpha")).unwrap();
        fs::create_dir(lib.path().join("omega")).unwrap();
        assert_eq!(lib.rename(pack.id, "omega").unwrap().short_name, "omega");
        assert_eq!(lib.folders(), vec!["omega"]);
    }

    #[test]
    fn short_name_is_locked_while_live() {
        let mut lib = Lib::new();
        let pack = lib.create("Pack", None).unwrap();
        set_status(&lib.conn, pack.id, PackStatus::Live).unwrap();
        let err = lib.rename(pack.id, "other").unwrap_err();
        assert!(err.contains("Live"), "unexpected error: {err}");
        assert_eq!(load_pack(&lib.conn, pack.id).unwrap().short_name, "pack");
        assert_eq!(lib.folders(), vec!["pack"]);
        // Unlocked again after toggling back to Draft.
        set_status(&lib.conn, pack.id, PackStatus::Draft).unwrap();
        assert_eq!(lib.rename(pack.id, "other").unwrap().short_name, "other");
    }

    /// Simulate a crash right after the Short Name edit committed: the row
    /// carries the new name plus the marker; the folder has the old name.
    fn commit_rename_without_moving(lib: &Lib, pack_id: i64, old: &str, new: &str) {
        lib.conn
            .execute(
                "UPDATE packs SET short_name = ?1, folder_rename_from = ?2 WHERE id = ?3",
                params![new, old, pack_id],
            )
            .unwrap();
    }

    #[test]
    fn a_pending_renames_old_name_counts_as_taken() {
        let mut lib = Lib::new();
        let a = lib.create("Pack", Some("cats")).unwrap();
        commit_rename_without_moving(&lib, a.id, "cats", "dogs");
        // Explicit create is refused; the folder still holds A's files.
        assert!(lib.create("Other", Some("cats")).unwrap_err().contains("already used"));
        assert!(lib.create("Other", Some("CATS")).is_err());
        // Auto-derivation skips past the old name.
        assert_eq!(lib.create("Cats", None).unwrap().short_name, "cats_2");
        // Renaming another pack onto it is refused too.
        let b = lib.create("B", Some("bee")).unwrap();
        assert!(lib.rename(b.id, "CATS").unwrap_err().contains("already used"));
        assert_eq!(lib.pack_count(), 3);
    }

    #[test]
    fn settle_rolls_an_interrupted_folder_rename_forward() {
        let mut lib = Lib::new();
        let pack = lib.create("Pack", Some("before")).unwrap();
        fs::write(lib.path().join("before").join("001.png"), "A").unwrap();
        commit_rename_without_moving(&lib, pack.id, "before", "after");
        let settled = settle_pack_folder(&lib.conn, lib.path(), pack.id).unwrap();
        assert_eq!(settled.folder_rename_from, None);
        assert_eq!(lib.folders(), vec!["after"]);
        assert_eq!(fs::read_to_string(lib.path().join("after").join("001.png")).unwrap(), "A");
        // Idempotent.
        settle_pack_folder(&lib.conn, lib.path(), pack.id).unwrap();
        assert_eq!(lib.folders(), vec!["after"]);
    }

    #[test]
    fn settle_clears_the_marker_when_the_rename_already_happened() {
        // Crash after the folder rename but before the marker was cleared.
        let mut lib = Lib::new();
        let pack = lib.create("Pack", Some("before")).unwrap();
        fs::rename(lib.path().join("before"), lib.path().join("after")).unwrap();
        commit_rename_without_moving(&lib, pack.id, "before", "after");
        let settled = settle_pack_folder(&lib.conn, lib.path(), pack.id).unwrap();
        assert_eq!(settled.folder_rename_from, None);
        assert_eq!(lib.folders(), vec!["after"]);
    }

    #[test]
    fn settle_refuses_when_both_folders_exist() {
        let mut lib = Lib::new();
        let pack = lib.create("Pack", Some("before")).unwrap();
        commit_rename_without_moving(&lib, pack.id, "before", "after");
        fs::create_dir(lib.path().join("after")).unwrap();
        let err = settle_pack_folder(&lib.conn, lib.path(), pack.id).unwrap_err();
        assert!(err.contains("outside the app"), "unexpected error: {err}");
        assert!(load_pack(&lib.conn, pack.id).unwrap().folder_rename_from.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn blocked_folder_rename_stays_pending_and_retries_later() {
        use std::os::unix::fs::PermissionsExt;
        let mut lib = Lib::new();
        let pack = lib.create("Pack", Some("before")).unwrap();
        // The edit committed; then the folder cannot be renamed — a
        // read-only Library folder stands in for a folder held open by
        // Explorer on Windows. (Read-only also blocks DB writes, so the
        // commit is simulated before the block is applied.)
        commit_rename_without_moving(&lib, pack.id, "before", "after");
        fs::set_permissions(lib.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let blocked = settle_pack_folder(&lib.conn, lib.path(), pack.id);
        fs::set_permissions(lib.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(blocked.unwrap_err().contains("close any window"));
        let pending = load_pack(&lib.conn, pack.id).unwrap();
        assert_eq!(pending.short_name, "after");
        assert_eq!(pending.folder_rename_from.as_deref(), Some("before"));
        assert_eq!(lib.folders(), vec!["before"]);
        // Once unblocked, the next edit settles first, then applies itself.
        let renamed = lib.rename(pack.id, "third").unwrap();
        assert_eq!(renamed.short_name, "third");
        assert_eq!(renamed.folder_rename_from, None);
        assert_eq!(lib.folders(), vec!["third"]);
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
            assert!(delete_pack(&lib.conn, lib.path(), pack.id).unwrap().is_none());
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
    fn delete_pack_removes_both_folders_of_a_pending_rename() {
        let mut lib = Lib::new();
        let pack = lib.create("Pack", Some("before")).unwrap();
        commit_rename_without_moving(&lib, pack.id, "before", "after");
        fs::create_dir(lib.path().join("after")).unwrap();
        assert!(delete_pack(&lib.conn, lib.path(), pack.id).unwrap().is_none());
        assert!(lib.folders().is_empty(), "left: {:?}", lib.folders());
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
    fn delete_pack_refuses_a_folder_value_outside_the_short_name_rules() {
        // Defence in depth: a corrupted short_name or rename marker ('',
        // '..', a path) must never become a recursive delete of the Library.
        for (column, bad) in [
            ("short_name", ""),
            ("short_name", ".."),
            ("short_name", "../elsewhere"),
            ("short_name", "library.db"),
            ("short_name", "a/b"),
            ("folder_rename_from", ".."),
            ("folder_rename_from", ""),
        ] {
            let mut lib = Lib::new();
            let pack = lib.create("P", None).unwrap();
            lib.conn
                .execute(&format!("UPDATE packs SET {column} = ?1 WHERE id = ?2"), params![bad, pack.id])
                .unwrap();
            assert!(delete_pack(&lib.conn, lib.path(), pack.id).is_err(), "accepted {column}={bad:?}");
            assert!(load_pack(&lib.conn, pack.id).is_ok(), "row deleted for {column}={bad:?}");
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

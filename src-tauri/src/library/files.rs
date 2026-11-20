//! Order-encoded filenames (ADR-0003) and the crash-safe rename engine
//! (ADR-0004).
//!
//! The DB commit is the single decision point: one transaction writes the
//! journal row (the plan) plus the final row state, THEN files move —
//! phase 1 vacates originals into deterministic temps, phase 2 places
//! finals (or unlinks deletes). Recovery on pack open/refresh replays the
//! journal idempotently (roll-forward); with no journal, stray temps are
//! pre-commit leftovers and are swept. See ADR-0004 for the crash windows.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use super::schema::Format;

/// Reserved prefix for every temporary file the core creates inside a pack
/// folder. Dot-prefixed temps never sort into the `001.png…` sequence the
/// owner drags into @Stickers, and the app never treats them as stickers.
pub const TEMP_PREFIX: &str = ".spm-tmp-";

/// Order-encoded sticker file name: three-digit zero-padded position plus
/// the actual format extension (`001.png`, `002.webp`, … ADR-0003).
pub fn sticker_file_name(position: i64, format: Format) -> String {
    format!("{position:03}.{}", format.as_str())
}

/// Unnumbered thumbnail file name; never sorts into the sticker sequence.
pub fn thumbnail_file_name(format: Format) -> String {
    format!("thumbnail.{}", format.as_str())
}

/// True for reserved temp names (staged copies and engine temps).
pub fn is_temp(name: &str) -> bool {
    name.starts_with(TEMP_PREFIX)
}

/// One step of a rename plan: the file currently named `from` becomes `to`,
/// or is deleted when `to` is None. `from` may be a staged temp name (a
/// pre-commit copy being adopted into the pack).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub from: String,
    pub to: Option<String>,
}

impl Step {
    pub fn rename(from: impl Into<String>, to: impl Into<String>) -> Self {
        Step { from: from.into(), to: Some(to.into()) }
    }

    pub fn delete(name: impl Into<String>) -> Self {
        Step { from: name.into(), to: None }
    }
}

/// Deterministic engine temp for plan step `index`. Deterministic names make
/// recovery trivial: the journal says exactly which temp belongs to which
/// step, and a replay never collides with itself.
fn temp_name(index: usize) -> String {
    format!("{TEMP_PREFIX}{index}")
}

static STAGE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Stage a pre-commit copy of `source` into the pack folder under a unique
/// reserved temp name, byte-verified (SPEC §5 Send-to-pack phase 1). Nothing
/// in the DB references it until the plan commits; on failure or rollback
/// the caller removes it via `remove_names`.
pub fn stage_copy(pack_dir: &Path, source: &Path) -> Result<String, String> {
    let seq = STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = format!("{TEMP_PREFIX}add-{nanos}-{seq}");
    copy_verified(source, &pack_dir.join(&name))?;
    Ok(name)
}

/// Copy a file and verify the copy byte-for-byte (sticker files are
/// ≤512 KB, so a full comparison is cheap). Removes the failed copy.
pub fn copy_verified(source: &Path, dest: &Path) -> Result<(), String> {
    fs::copy(source, dest)
        .map_err(|e| format!("cannot copy {} to {}: {e}", source.display(), dest.display()))?;
    let original = fs::read(source)
        .map_err(|e| format!("cannot read {}: {e}", source.display()))?;
    let copied = fs::read(dest)
        .map_err(|e| format!("cannot read back copy {}: {e}", dest.display()))?;
    if original != copied {
        let _ = fs::remove_file(dest);
        return Err(format!("copy verification failed for {}", dest.display()));
    }
    Ok(())
}

/// Best-effort removal of several names (staged-copy rollback): attempts
/// every name, ignores already-absent ones, reports the first real error.
pub fn remove_names(pack_dir: &Path, names: &[String]) -> Result<(), String> {
    let mut first_error = None;
    for name in names {
        match fs::remove_file(pack_dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                if first_error.is_none() {
                    first_error = Some(format!("cannot remove {}: {e}", pack_dir.join(name).display()));
                }
            }
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn load_journal(conn: &Connection, pack_id: i64) -> Result<Option<(Vec<Step>, i64)>, String> {
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT plan, phase FROM rename_journal WHERE pack_id = ?1",
            params![pack_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("cannot read rename journal of pack {pack_id}: {e}"))?;
    match row {
        None => Ok(None),
        Some((json, phase)) => serde_json::from_str(&json)
            .map(|steps| Some((steps, phase)))
            .map_err(|e| format!("rename journal of pack {pack_id} is corrupt: {e}")),
    }
}

/// True when a committed rename plan for the pack is still pending (its
/// file moves will be rolled forward by `recover`). Callers use it to tell
/// a pre-commit failure (nothing changed; staged copies may be discarded)
/// from a post-commit one (the operation stands and will complete).
pub fn has_pending_plan(conn: &Connection, pack_id: i64) -> Result<bool, String> {
    Ok(load_journal(conn, pack_id)?.is_some())
}

fn clear_journal(conn: &Connection, pack_id: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM rename_journal WHERE pack_id = ?1",
        params![pack_id],
    )
    .map_err(|e| format!("cannot clear rename journal of pack {pack_id}: {e}"))?;
    Ok(())
}

/// Delete leftover temp files when no journal exists: they can only be
/// remnants of a crash during pre-commit staging, which no committed state
/// references (ADR-0004).
fn sweep_stray_temps(pack_dir: &Path) -> Result<(), String> {
    let entries = fs::read_dir(pack_dir)
        .map_err(|e| format!("cannot read pack folder {}: {e}", pack_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read pack folder entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_temp(&name) {
            fs::remove_file(entry.path())
                .map_err(|e| format!("cannot remove leftover temp {}: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}

fn tampered(path: &Path) -> String {
    format!(
        "rename recovery found conflicting files at {}; the pack folder was modified outside the app",
        path.display()
    )
}

/// Phase boundaries where a crash can be simulated in tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultPoint {
    AfterCommit,
    AfterPhase1,
    AfterPhase1Marked,
    Phase2Step(usize),
    BeforeJournalCleanup,
}

/// Apply a rename plan to one pack: commit the journal + row mutations, then
/// move files in two phases. `mutate` runs inside the commit transaction and
/// must bring the rows to the plan's final state (renumber via vacate-then-
/// assign; SQLite cannot defer composite UNIQUE). A pending journal from an
/// interrupted operation is rolled forward first; stray temps are NOT swept
/// here, so copies the caller staged for this plan survive.
pub fn apply_plan(
    conn: &mut Connection,
    pack_dir: &Path,
    pack_id: i64,
    steps: &[Step],
    mutate: impl FnOnce(&Transaction) -> Result<(), String>,
) -> Result<(), String> {
    apply_plan_with_fault(conn, pack_dir, pack_id, steps, mutate, &|_| Ok(()))
}

/// Crash-simulation seam (tests only in spirit): `fault` is invoked at each
/// phase boundary and may abort the engine, leaving the committed journal
/// for `recover` to roll forward — exactly what a process death would do.
pub fn apply_plan_with_fault(
    conn: &mut Connection,
    pack_dir: &Path,
    pack_id: i64,
    steps: &[Step],
    mutate: impl FnOnce(&Transaction) -> Result<(), String>,
    fault: &dyn Fn(FaultPoint) -> Result<(), String>,
) -> Result<(), String> {
    roll_forward(conn, pack_dir, pack_id)?;

    if steps.is_empty() {
        let tx = conn
            .transaction()
            .map_err(|e| format!("cannot start transaction: {e}"))?;
        mutate(&tx)?;
        tx.commit().map_err(|e| format!("cannot commit: {e}"))?;
        return Ok(());
    }

    // The decision point: journal + final row state commit together.
    let plan_json = serde_json::to_string(steps)
        .map_err(|e| format!("cannot serialize rename plan: {e}"))?;
    {
        let tx = conn
            .transaction()
            .map_err(|e| format!("cannot start transaction: {e}"))?;
        tx.execute(
            "INSERT INTO rename_journal (pack_id, plan) VALUES (?1, ?2)",
            params![pack_id, plan_json],
        )
        .map_err(|e| format!("cannot write rename journal: {e}"))?;
        mutate(&tx)?;
        tx.commit()
            .map_err(|e| format!("cannot commit rename decision: {e}"))?;
    }
    fault(FaultPoint::AfterCommit)?;

    // Phase 1 — vacate: every source moves to its deterministic temp, so no
    // final name is occupied when phase 2 places files (collision-free even
    // for swaps). Absent sources (Missing slots) are skipped.
    for (i, step) in steps.iter().enumerate() {
        let from = pack_dir.join(&step.from);
        let temp = pack_dir.join(temp_name(i));
        if from.exists() {
            if temp.exists() {
                return Err(tampered(&temp));
            }
            fs::rename(&from, &temp)
                .map_err(|e| format!("cannot rename {} to temp: {e}", from.display()))?;
        }
    }
    fault(FaultPoint::AfterPhase1)?;

    // Mark phase 1 complete BEFORE any placement: from here on, an original
    // name may be legitimately re-occupied by a phase-2 placement, so
    // recovery must not re-vacate sources (it only places remaining temps).
    conn.execute(
        "UPDATE rename_journal SET phase = 1 WHERE pack_id = ?1",
        params![pack_id],
    )
    .map_err(|e| format!("cannot mark rename phase: {e}"))?;
    fault(FaultPoint::AfterPhase1Marked)?;

    // Phase 2 — place: temps become finals (or are unlinked), in plan order
    // so delete steps vacate names before placements that reuse them.
    for (i, step) in steps.iter().enumerate() {
        let temp = pack_dir.join(temp_name(i));
        if temp.exists() {
            match &step.to {
                Some(to) => {
                    let dest = pack_dir.join(to);
                    if dest.exists() {
                        return Err(tampered(&dest));
                    }
                    fs::rename(&temp, &dest)
                        .map_err(|e| format!("cannot rename temp to {}: {e}", dest.display()))?;
                }
                None => {
                    fs::remove_file(&temp)
                        .map_err(|e| format!("cannot delete {}: {e}", temp.display()))?;
                }
            }
        }
        fault(FaultPoint::Phase2Step(i))?;
    }

    fault(FaultPoint::BeforeJournalCleanup)?;
    clear_journal(conn, pack_id)?;
    Ok(())
}

/// Roll an interrupted operation forward to its committed state, then sweep
/// stray pre-commit temps. Idempotent; runs on pack open and manual refresh
/// BEFORE desync detection, never on app start (SPEC §4, ADR-0004).
/// Operations call it before staging anything, never between staging and
/// `apply_plan` — the sweep would delete their staged copies.
pub fn recover(conn: &Connection, pack_dir: &Path, pack_id: i64) -> Result<(), String> {
    roll_forward(conn, pack_dir, pack_id)?;
    sweep_stray_temps(pack_dir)
}

/// Complete a pending journal, if any. Unlike `recover` it never sweeps:
/// `apply_plan` runs it after the caller has staged copies for this very
/// plan, and those staged temps must survive until the plan adopts them.
fn roll_forward(conn: &Connection, pack_dir: &Path, pack_id: i64) -> Result<(), String> {
    if let Some((steps, phase)) = load_journal(conn, pack_id)? {
        // Pass A: complete phase 1 for any source still under its old name —
        // only while phase 1 is unconfirmed. Once phase 2 has placed files,
        // an original name can be legitimately occupied again, and every
        // original was already vacated (phase 1 runs to completion first).
        if phase == 0 {
            for (i, step) in steps.iter().enumerate() {
                let from = pack_dir.join(&step.from);
                let temp = pack_dir.join(temp_name(i));
                if from.exists() {
                    if temp.exists() {
                        return Err(tampered(&temp));
                    }
                    fs::rename(&from, &temp)
                        .map_err(|e| format!("cannot rename {} to temp: {e}", from.display()))?;
                }
            }
        }
        // Pass B: complete phase 2 for any remaining temp. An absent temp
        // means the step already finished — or its source was Missing, in
        // which case the slot stays file-less (genuine Missing, not an error).
        for (i, step) in steps.iter().enumerate() {
            let temp = pack_dir.join(temp_name(i));
            if !temp.exists() {
                continue;
            }
            match &step.to {
                Some(to) => {
                    let dest = pack_dir.join(to);
                    if dest.exists() {
                        return Err(tampered(&dest));
                    }
                    fs::rename(&temp, &dest)
                        .map_err(|e| format!("cannot rename temp to {}: {e}", dest.display()))?;
                }
                None => {
                    fs::remove_file(&temp)
                        .map_err(|e| format!("cannot delete {}: {e}", temp.display()))?;
                }
            }
        }
        clear_journal(conn, pack_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;
    use std::fs;
    use std::path::Path;

    /// A pack folder with known files plus a migrated in-memory DB holding
    /// pack 1 and one sticker row per seeded file (id = index + 1).
    struct Harness {
        dir: tempfile::TempDir,
        conn: Connection,
    }

    impl Harness {
        fn new(files: &[(&str, &str)]) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let mut conn = Connection::open_in_memory().unwrap();
            db::migrate(&mut conn).unwrap();
            conn.execute(
                "INSERT INTO packs (id, title, short_name) VALUES (1, 'T', 't')",
                [],
            )
            .unwrap();
            for (i, (name, content)) in files.iter().enumerate() {
                fs::write(dir.path().join(name), content).unwrap();
                conn.execute(
                    "INSERT INTO stickers (id, pack_id, position, file_name, format)
                         VALUES (?1, 1, ?2, ?3, 'png')",
                    params![i as i64 + 1, i as i64 + 1, name],
                )
                .unwrap();
            }
            Harness { dir, conn }
        }

        fn path(&self) -> &Path {
            self.dir.path()
        }

        fn read(&self, name: &str) -> Option<String> {
            fs::read_to_string(self.path().join(name)).ok()
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(self.path())
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }

        fn rows(&self) -> Vec<(i64, i64, String)> {
            let mut stmt = self
                .conn
                .prepare("SELECT id, position, file_name FROM stickers ORDER BY position")
                .unwrap();
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            rows
        }

        fn journal_count(&self) -> i64 {
            self.conn
                .query_row("SELECT COUNT(*) FROM rename_journal WHERE pack_id = 1", [], |r| {
                    r.get(0)
                })
                .unwrap()
        }
    }

    fn exec(tx: &rusqlite::Transaction, sql: &str) -> Result<(), String> {
        tx.execute_batch(sql).map_err(|e| e.to_string())
    }

    /// Rotation of three files plus a delete: 001->002, 002->003, 003->001,
    /// delete 004. Final rows: id3@1, id1@2, id2@3.
    fn rotation_plan() -> Vec<Step> {
        vec![
            Step::delete("004.png"),
            Step::rename("001.png", "002.png"),
            Step::rename("002.png", "003.png"),
            Step::rename("003.png", "001.png"),
        ]
    }

    fn rotation_mutate(tx: &rusqlite::Transaction) -> Result<(), String> {
        exec(tx, "DELETE FROM stickers WHERE id = 4")?;
        exec(
            tx,
            "UPDATE stickers SET position = position + 1000000, file_name = '.dbtmp-' || id
                 WHERE pack_id = 1;
             UPDATE stickers SET position = 2, file_name = '002.png' WHERE id = 1;
             UPDATE stickers SET position = 3, file_name = '003.png' WHERE id = 2;
             UPDATE stickers SET position = 1, file_name = '001.png' WHERE id = 3;",
        )
    }

    fn assert_rotation_final(h: &Harness) {
        assert_eq!(h.read("001.png").as_deref(), Some("C"));
        assert_eq!(h.read("002.png").as_deref(), Some("A"));
        assert_eq!(h.read("003.png").as_deref(), Some("B"));
        assert_eq!(h.read("004.png"), None);
        assert_eq!(
            h.rows(),
            vec![
                (3, 1, "001.png".to_string()),
                (1, 2, "002.png".to_string()),
                (2, 3, "003.png".to_string()),
            ]
        );
        assert_eq!(h.journal_count(), 0);
        assert!(h.names().iter().all(|n| !is_temp(n)));
    }

    fn four_files() -> Harness {
        Harness::new(&[
            ("001.png", "A"),
            ("002.png", "B"),
            ("003.png", "C"),
            ("004.png", "D"),
        ])
    }

    #[test]
    fn file_names_are_order_encoded() {
        assert_eq!(sticker_file_name(1, Format::Png), "001.png");
        assert_eq!(sticker_file_name(12, Format::Webp), "012.webp");
        assert_eq!(sticker_file_name(120, Format::Png), "120.png");
        assert_eq!(thumbnail_file_name(Format::Png), "thumbnail.png");
        assert_eq!(thumbnail_file_name(Format::Webp), "thumbnail.webp");
    }

    #[test]
    fn swap_moves_contents_without_collision() {
        let mut h = Harness::new(&[("001.png", "A"), ("002.png", "B")]);
        let steps = vec![
            Step::rename("001.png", "002.png"),
            Step::rename("002.png", "001.png"),
        ];
        let Harness { dir, conn } = &mut h;
        apply_plan(
            conn,
            dir.path(),
            1,
            &steps,
            |tx| {
                exec(
                    tx,
                    "UPDATE stickers SET position = position + 1000000, file_name = '.dbtmp-' || id
                         WHERE pack_id = 1;
                     UPDATE stickers SET position = 2, file_name = '002.png' WHERE id = 1;
                     UPDATE stickers SET position = 1, file_name = '001.png' WHERE id = 2;",
                )
            },
        )
        .unwrap();
        assert_eq!(h.read("001.png").as_deref(), Some("B"));
        assert_eq!(h.read("002.png").as_deref(), Some("A"));
        assert_eq!(h.names(), vec!["001.png", "002.png"]);
        assert_eq!(h.journal_count(), 0);
    }

    #[test]
    fn absent_source_is_skipped_not_an_error() {
        // Reordering a pack with a Missing sticker: its slot moves in the DB
        // but there is no file to rename (SPEC §3, ADR-0003).
        let mut h = Harness::new(&[("001.png", "A")]);
        h.conn
            .execute(
                "INSERT INTO stickers (id, pack_id, position, file_name, format)
                     VALUES (2, 1, 2, '002.png', 'png')",
                [],
            )
            .unwrap();
        let steps = vec![
            Step::rename("002.png", "001.png"),
            Step::rename("001.png", "002.png"),
        ];
        let Harness { dir, conn } = &mut h;
        apply_plan(conn, dir.path(), 1, &steps, |tx| {
            exec(
                tx,
                "UPDATE stickers SET position = position + 1000000, file_name = '.dbtmp-' || id
                     WHERE pack_id = 1;
                 UPDATE stickers SET position = 1, file_name = '001.png' WHERE id = 2;
                 UPDATE stickers SET position = 2, file_name = '002.png' WHERE id = 1;",
            )
        })
        .unwrap();
        assert_eq!(h.read("001.png"), None);
        assert_eq!(h.read("002.png").as_deref(), Some("A"));
    }

    #[test]
    fn crash_at_any_phase_boundary_recovers_to_the_committed_state() {
        let points = [
            FaultPoint::AfterCommit,
            FaultPoint::AfterPhase1,
            FaultPoint::AfterPhase1Marked,
            FaultPoint::Phase2Step(0),
            FaultPoint::Phase2Step(1),
            FaultPoint::Phase2Step(2),
            FaultPoint::Phase2Step(3),
            FaultPoint::BeforeJournalCleanup,
        ];
        for point in points {
            let mut h = four_files();
            let steps = rotation_plan();
            let Harness { dir, conn } = &mut h;
            let err = apply_plan_with_fault(
                conn,
                dir.path(),
                1,
                &steps,
                rotation_mutate,
                &|p| {
                    if p == point {
                        Err("simulated crash".to_string())
                    } else {
                        Ok(())
                    }
                },
            )
            .unwrap_err();
            assert_eq!(err, "simulated crash");
            // The decision committed: the journal must be present.
            assert_eq!(h.journal_count(), 1, "no journal after crash at {point:?}");

            recover(&h.conn, h.path(), 1).unwrap();
            assert_rotation_final(&h);
            // Recovery is idempotent.
            recover(&h.conn, h.path(), 1).unwrap();
            assert_rotation_final(&h);
        }
    }

    #[test]
    fn failed_mutation_aborts_before_commit_with_no_trace() {
        let mut h = four_files();
        let before = h.names();
        let Harness { dir, conn } = &mut h;
        let err = apply_plan(conn, dir.path(), 1, &rotation_plan(), |_| {
            Err("mutation failed".to_string())
        })
        .unwrap_err();
        assert_eq!(err, "mutation failed");
        assert_eq!(h.journal_count(), 0);
        assert_eq!(h.names(), before);
        assert_eq!(h.rows().len(), 4);
        // Stray temps from an interrupted pre-commit stage are swept on open.
        fs::write(h.path().join(".spm-tmp-add-123"), "leftover").unwrap();
        recover(&h.conn, h.path(), 1).unwrap();
        assert_eq!(h.names(), before);
    }

    #[test]
    fn recovery_refuses_when_folder_was_tampered_with() {
        let mut h = four_files();
        let Harness { dir, conn } = &mut h;
        apply_plan_with_fault(
            conn,
            dir.path(),
            1,
            &rotation_plan(),
            rotation_mutate,
            &|p| {
                if p == FaultPoint::AfterCommit {
                    Err("simulated crash".to_string())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        // External tampering: both the original and its temp exist.
        fs::write(h.path().join(temp_name(1)), "forged").unwrap();
        let err = recover(&h.conn, h.path(), 1).unwrap_err();
        assert!(err.contains("outside the app"), "unexpected error: {err}");
    }

    #[test]
    fn new_operation_recovers_a_pending_one_first() {
        let mut h = four_files();
        let Harness { dir, conn } = &mut h;
        apply_plan_with_fault(
            conn,
            dir.path(),
            1,
            &rotation_plan(),
            rotation_mutate,
            &|p| {
                if p == FaultPoint::AfterPhase1 {
                    Err("simulated crash".to_string())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        // A second operation on the same pack rolls the first forward, then
        // applies itself: delete the sticker now at 001.png (id 3).
        apply_plan(
            conn,
            dir.path(),
            1,
            &[Step::delete("001.png")],
            |tx| exec(tx, "DELETE FROM stickers WHERE id = 3"),
        )
        .unwrap();
        assert_eq!(h.read("001.png"), None);
        assert_eq!(h.read("002.png").as_deref(), Some("A"));
        assert_eq!(h.read("003.png").as_deref(), Some("B"));
        assert_eq!(h.journal_count(), 0);
        assert!(h.names().iter().all(|n| !is_temp(n)));
    }

    #[test]
    fn empty_plan_just_runs_the_mutation() {
        let mut h = four_files();
        let Harness { dir, conn } = &mut h;
        apply_plan(conn, dir.path(), 1, &[], |tx| {
            exec(tx, "UPDATE packs SET title = 'Renamed' WHERE id = 1")
        })
        .unwrap();
        assert_eq!(h.journal_count(), 0);
        let title: String = h
            .conn
            .query_row("SELECT title FROM packs WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Renamed");
    }

    #[test]
    fn stage_copy_produces_verified_temp_and_rollback_removes_it() {
        let h = four_files();
        let src = h.dir.path().join("source.png");
        fs::write(&src, "image bytes").unwrap();
        let staged = stage_copy(h.path(), &src).unwrap();
        assert!(is_temp(&staged));
        assert_eq!(h.read(&staged).as_deref(), Some("image bytes"));
        remove_names(h.path(), std::slice::from_ref(&staged)).unwrap();
        assert_eq!(h.read(&staged), None);
        // Removing an already-absent name is not an error (rollback retry).
        remove_names(h.path(), &[staged]).unwrap();
    }

    #[test]
    fn plan_adopts_a_copy_staged_just_before_it() {
        // Regression: apply_plan must not sweep the caller's staged temps.
        let mut h = Harness::new(&[("001.png", "A")]);
        let src = h.dir.path().join("source.png");
        fs::write(&src, "B").unwrap();
        let staged = stage_copy(h.path(), &src).unwrap();
        fs::remove_file(&src).unwrap();
        let Harness { dir, conn } = &mut h;
        apply_plan(conn, dir.path(), 1, &[Step::rename(staged, "002.png")], |tx| {
            exec(
                tx,
                "INSERT INTO stickers (id, pack_id, position, file_name, format)
                     VALUES (2, 1, 2, '002.png', 'png')",
            )
        })
        .unwrap();
        assert_eq!(h.read("002.png").as_deref(), Some("B"));
        assert_eq!(h.names(), vec!["001.png", "002.png"]);
    }

    #[test]
    fn stage_copy_of_missing_source_leaves_no_temp() {
        let h = four_files();
        let before = h.names();
        assert!(stage_copy(h.path(), &h.path().join("nope.png")).is_err());
        assert_eq!(h.names(), before);
    }
}
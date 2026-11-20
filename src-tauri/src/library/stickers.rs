//! Sticker operations (SPEC §3-5): add/insert, reorder, delete (including
//! Missing slots), Emoji String edits, file replacement, and the two-phase
//! Send to pack. Every operation that changes a pack's files reduces to one
//! internal `apply_new_order`, the single enforcement point of the
//! contiguous-positions invariant (ADR-0003) on top of the crash-safe
//! rename engine (ADR-0004).

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, Transaction};
use serde::Serialize;
use unicode_segmentation::UnicodeSegmentation;

use super::files::{self, has_pending_plan, remove_names, stage_copy, sticker_file_name, Step};
use super::packs::open_pack_files;
use super::schema::{load_pack, load_sticker, load_stickers, Format, Sticker};
use crate::limits::{EMOJI_MAX, EMOJI_MIN, KB, PACK_MAX_STICKERS, STICKER_MAX_KB, STICKER_SIDE};

/// Largest sticker file Telegram accepts (SPEC §7).
pub const MAX_STICKER_BYTES: u64 = STICKER_MAX_KB * KB;

/// A warn-only condition (SPEC §3: drafts may be incomplete).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Warning {
    /// Emoji String outside the allowed emoji count.
    EmojiCount { count: usize },
    /// Pack above the pack sticker cap.
    PackSize { count: usize },
}

/// A per-file problem (rejected import, failed copy, Missing source).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileError {
    pub path: PathBuf,
    pub reason: String,
}

/// An image to add to a pack, with the Emoji String it starts with.
#[derive(Debug, Clone)]
pub struct NewSticker {
    pub path: PathBuf,
    pub emoji_string: String,
}

/// Result of `add_stickers`: valid files are added, invalid ones rejected
/// per file (SPEC §5 bulk import).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddOutcome {
    pub added: Vec<Sticker>,
    pub rejected: Vec<FileError>,
    pub pack_size_warning: Option<Warning>,
}

/// Final state of a completed Send to pack (SPEC §5).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReport {
    pub copied: Vec<Sticker>,
    pub originals_deleted: bool,
    /// What did not complete — None when everything finished.
    pub unfinished: Option<String>,
    pub target_size_warning: Option<Warning>,
}

/// A Send to pack that changed nothing (or kept the originals), with the
/// per-file errors behind it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendFailure {
    pub message: String,
    pub file_errors: Vec<FileError>,
}

/// Number of emoji in an Emoji String, counted as grapheme clusters so a
/// ZWJ family, a flag, or a skin-toned emoji counts once. Whitespace is not
/// an emoji and is not counted.
pub fn emoji_count(emoji_string: &str) -> usize {
    emoji_string
        .graphemes(true)
        .filter(|g| !g.chars().all(char::is_whitespace))
        .count()
}

/// Warn when an Emoji String is outside the allowed emoji count (warn only, SPEC §3).
pub fn emoji_warning(emoji_string: &str) -> Option<Warning> {
    let count = emoji_count(emoji_string);
    (!(EMOJI_MIN..=EMOJI_MAX).contains(&count)).then_some(Warning::EmojiCount { count })
}

/// Warn when a pack holds more than the pack sticker cap (warn only, SPEC §3).
pub fn pack_size_warning(count: usize) -> Option<Warning> {
    (count > PACK_MAX_STICKERS).then_some(Warning::PackSize { count })
}

/// Validate a file entering a pack as a sticker (drop-in, bulk import,
/// replacement; SPEC §5, §7): PNG or WEBP by extension AND by content
/// signature, at most `STICKER_MAX_KB`, and one side exactly `STICKER_SIDE`
/// with the other at most that (read from the image header, not decoded).
/// Returns its format.
pub fn validate_sticker_file(path: &Path) -> Result<Format, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| "has no file extension; expected .png or .webp".to_string())?;
    let format = Format::from_extension(ext)?;
    let meta = fs::metadata(path).map_err(|e| format!("cannot read file: {e}"))?;
    if !meta.is_file() {
        return Err("is not a file".to_string());
    }
    if meta.len() > MAX_STICKER_BYTES {
        return Err(format!(
            "is {} KB; stickers must be at most {STICKER_MAX_KB} KB",
            meta.len().div_ceil(KB)
        ));
    }
    let mut head = [0u8; 12];
    let read = fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .map_err(|e| format!("cannot read file: {e}"))?;
    let head = &head[..read];
    let matches = match format {
        Format::Png => head.starts_with(b"\x89PNG\r\n\x1a\n"),
        Format::Webp => head.len() == 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP",
    };
    if !matches {
        return Err(format!(
            "is not a real {} image (its content does not match the extension)",
            format.as_str().to_ascii_uppercase()
        ));
    }
    let (width, height) = image_dimensions(path)?;
    if !sticker_dimensions_ok(width, height) {
        return Err(format!(
            "is {width}×{height} px; one side must be exactly {STICKER_SIDE} px and the other at most {STICKER_SIDE} px"
        ));
    }
    Ok(format)
}

/// True when `width`×`height` fits a sticker: the longest side exactly
/// `STICKER_SIDE` (so the other is at most that). SPEC §7.
pub fn sticker_dimensions_ok(width: u32, height: u32) -> bool {
    width.max(height) == STICKER_SIDE
}

/// An image file's pixel size from its header (no full decode).
pub fn image_dimensions(path: &Path) -> Result<(u32, u32), String> {
    image::ImageReader::open(path)
        .and_then(|r| r.with_guessed_format())
        .map_err(|e| format!("cannot read file: {e}"))?
        .into_dimensions()
        .map_err(|e| format!("cannot read the image size: {e}"))
}

/// Where a slot's file comes from: the sticker's current file, or a staged
/// pre-commit copy being adopted (ADR-0004 step 1).
enum SlotFile {
    Current(String),
    Staged(String),
}

/// One position of a pack's new order. `sticker_id` None inserts a new row.
struct Slot {
    sticker_id: Option<i64>,
    file: SlotFile,
    format: Format,
    emoji_string: String,
}

impl Slot {
    fn keep(sticker: &Sticker) -> Self {
        Slot {
            sticker_id: Some(sticker.id),
            file: SlotFile::Current(sticker.file_name.clone()),
            format: sticker.format,
            emoji_string: sticker.emoji_string.clone(),
        }
    }
}

/// Offset that vacates positions inside the commit transaction (SQLite
/// cannot defer composite UNIQUE, ADR-0004).
const VACATE_OFFSET: i64 = 1_000_000;

/// The single path by which a pack's sticker files change: `slots` is the
/// complete new order (every surviving sticker exactly once), `deleted` the
/// stickers removed, `drop_files` extra files to unlink (a replaced file).
/// Builds the rename plan and the row mutations together and runs them
/// through the crash-safe engine, so positions are 1..N and file names
/// order-encoded after every operation (ADR-0003).
fn apply_new_order(
    conn: &mut Connection,
    dir: &Path,
    pack_id: i64,
    slots: &[Slot],
    deleted: &[Sticker],
    drop_files: &[String],
) -> Result<(), String> {
    // Deletes first: they vacate names before placements reuse them.
    let mut steps: Vec<Step> = deleted
        .iter()
        .map(|s| s.file_name.clone())
        .chain(drop_files.iter().cloned())
        .map(Step::delete)
        .collect();
    for (i, slot) in slots.iter().enumerate() {
        let to = sticker_file_name(i as i64 + 1, slot.format);
        match &slot.file {
            SlotFile::Current(name) if *name == to => {}
            SlotFile::Current(name) | SlotFile::Staged(name) => steps.push(Step::rename(name.clone(), to)),
        }
    }
    files::apply_plan(conn, dir, pack_id, &steps, |tx| write_rows(tx, pack_id, slots, deleted))
}

fn write_rows(tx: &Transaction, pack_id: i64, slots: &[Slot], deleted: &[Sticker]) -> Result<(), String> {
    let db = |e: rusqlite::Error| format!("cannot update stickers of pack {pack_id}: {e}");
    for s in deleted {
        tx.execute("DELETE FROM stickers WHERE id = ?1 AND pack_id = ?2", params![s.id, pack_id])
            .map_err(db)?;
    }
    tx.execute(
        "UPDATE stickers SET position = position + ?1, file_name = '.dbtmp-' || id WHERE pack_id = ?2",
        params![VACATE_OFFSET, pack_id],
    )
    .map_err(db)?;
    for (i, slot) in slots.iter().enumerate() {
        let position = i as i64 + 1;
        let file_name = sticker_file_name(position, slot.format);
        match slot.sticker_id {
            Some(id) => {
                tx.execute(
                    "UPDATE stickers SET position = ?1, file_name = ?2, format = ?3
                         WHERE id = ?4 AND pack_id = ?5",
                    params![position, file_name, slot.format.as_str(), id, pack_id],
                )
                .map_err(db)?;
            }
            None => {
                tx.execute(
                    "INSERT INTO stickers (pack_id, position, file_name, format, emoji_string)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![pack_id, position, file_name, slot.format.as_str(), slot.emoji_string],
                )
                .map_err(db)?;
            }
        }
    }
    // Invariant guard: a sticker left out of `slots` would stay vacated.
    let stranded: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM stickers WHERE pack_id = ?1 AND position > ?2",
            params![pack_id, VACATE_OFFSET],
            |r| r.get(0),
        )
        .map_err(db)?;
    if stranded != 0 {
        return Err(format!("internal error: new order of pack {pack_id} omits {stranded} sticker(s)"));
    }
    Ok(())
}

/// Remove staged copies after a failed operation — only when nothing was
/// committed. After a commit the journal owns them and recovery places
/// them, so they must stay.
fn discard_staged(conn: &Connection, dir: &Path, pack_id: i64, staged: &[String]) {
    // Err means the commit state is unknown. Only a definite "not committed" may delete; when unknown the staged
    // copies stay, and the next open's recover rolls forward or sweeps them.
    if let Ok(false) = has_pending_plan(conn, pack_id) {
        let _ = remove_names(dir, staged);
    }
}

/// Add images to a pack (bulk import, Editor save): each valid file is
/// copied in as a new sticker, in the given order, appended at the end or
/// inserted at 1-based `at` (later stickers renumber). Invalid files are
/// rejected per file and do not stop the others (SPEC §5).
pub fn add_stickers(
    conn: &mut Connection,
    library_dir: &Path,
    pack_id: i64,
    new: &[NewSticker],
    at: Option<i64>,
) -> Result<AddOutcome, String> {
    let (_, dir) = open_pack_files(conn, library_dir, pack_id)?;
    let existing = load_stickers(conn, pack_id)?;
    let count = existing.len() as i64;
    let at = at.unwrap_or(count + 1);
    if at < 1 || at > count + 1 {
        return Err(format!("position {at} is outside 1-{}", count + 1));
    }

    let mut rejected = Vec::new();
    let mut staged = Vec::new();
    let mut staged_names = Vec::new();
    for item in new {
        let copied = validate_sticker_file(&item.path)
            .and_then(|format| stage_copy(&dir, &item.path).map(|temp| (temp, format)));
        match copied {
            Ok((temp, format)) => {
                staged_names.push(temp.clone());
                staged.push(Slot {
                    sticker_id: None,
                    file: SlotFile::Staged(temp),
                    format,
                    emoji_string: item.emoji_string.clone(),
                });
            }
            Err(reason) => rejected.push(FileError { path: item.path.clone(), reason }),
        }
    }
    let added_count = staged.len();
    if added_count == 0 {
        return Ok(AddOutcome { added: Vec::new(), rejected, pack_size_warning: None });
    }

    let insert_index = (at - 1) as usize;
    let mut slots: Vec<Slot> = existing.iter().map(Slot::keep).collect();
    slots.splice(insert_index..insert_index, staged);
    if let Err(e) = apply_new_order(conn, &dir, pack_id, &slots, &[], &[]) {
        discard_staged(conn, &dir, pack_id, &staged_names);
        return Err(e);
    }

    let all = load_stickers(conn, pack_id)?;
    Ok(AddOutcome {
        added: all[insert_index..insert_index + added_count].to_vec(),
        rejected,
        pack_size_warning: pack_size_warning(all.len()),
    })
}

/// Move one sticker to 1-based `new_position` (Reorder mode); files are
/// renamed to match. A Missing sticker's slot moves without a file.
pub fn reorder_sticker(
    conn: &mut Connection,
    library_dir: &Path,
    sticker_id: i64,
    new_position: i64,
) -> Result<Vec<Sticker>, String> {
    let pack_id = load_sticker(conn, sticker_id)?.pack_id;
    let (_, dir) = open_pack_files(conn, library_dir, pack_id)?;
    let mut stickers = load_stickers(conn, pack_id)?;
    let count = stickers.len() as i64;
    if new_position < 1 || new_position > count {
        return Err(format!("position {new_position} is outside 1-{count}"));
    }
    let from = stickers
        .iter()
        .position(|s| s.id == sticker_id)
        .ok_or_else(|| format!("sticker {sticker_id} does not exist"))?;
    let moved = stickers.remove(from);
    stickers.insert((new_position - 1) as usize, moved);
    let slots: Vec<Slot> = stickers.iter().map(Slot::keep).collect();
    apply_new_order(conn, &dir, pack_id, &slots, &[], &[])?;
    load_stickers(conn, pack_id)
}

/// Split a pack's stickers into (kept, selected) for `sticker_ids`, which
/// must be non-empty and all belong to the pack.
fn select(stickers: Vec<Sticker>, pack_id: i64, sticker_ids: &[i64]) -> Result<(Vec<Sticker>, Vec<Sticker>), String> {
    if sticker_ids.is_empty() {
        return Err("no stickers selected".to_string());
    }
    let wanted: HashSet<i64> = sticker_ids.iter().copied().collect();
    let (selected, kept): (Vec<Sticker>, Vec<Sticker>) =
        stickers.into_iter().partition(|s| wanted.contains(&s.id));
    if selected.len() != wanted.len() {
        return Err(format!("some selected stickers are not in pack {pack_id}"));
    }
    Ok((kept, selected))
}

/// Delete stickers (Missing ones included) and renumber the pack to fill
/// the gaps (SPEC §5). Returns the remaining stickers.
pub fn delete_stickers(
    conn: &mut Connection,
    library_dir: &Path,
    pack_id: i64,
    sticker_ids: &[i64],
) -> Result<Vec<Sticker>, String> {
    let (_, dir) = open_pack_files(conn, library_dir, pack_id)?;
    let (kept, deleted) = select(load_stickers(conn, pack_id)?, pack_id, sticker_ids)?;
    let slots: Vec<Slot> = kept.iter().map(Slot::keep).collect();
    apply_new_order(conn, &dir, pack_id, &slots, &deleted, &[])?;
    load_stickers(conn, pack_id)
}

/// Set a sticker's Emoji String exactly as given (one-click copy must
/// reproduce it). Never blocks: check `emoji_warning` for the emoji count rule.
pub fn set_emoji_string(conn: &Connection, sticker_id: i64, emoji_string: &str) -> Result<Sticker, String> {
    let changed = conn
        .execute(
            "UPDATE stickers SET emoji_string = ?1 WHERE id = ?2",
            params![emoji_string, sticker_id],
        )
        .map_err(|e| format!("cannot update sticker {sticker_id}: {e}"))?;
    if changed == 0 {
        return Err(format!("sticker {sticker_id} does not exist"));
    }
    load_sticker(conn, sticker_id)
}

/// Replace a sticker's image (validated drop-in or Editor save, SPEC §5),
/// keeping its identity, position, and Emoji String. The format may change
/// (`002.png` → `002.webp`). This is also how a Missing sticker is fixed.
pub fn replace_sticker_file(
    conn: &mut Connection,
    library_dir: &Path,
    sticker_id: i64,
    source: &Path,
) -> Result<Sticker, String> {
    let format = validate_sticker_file(source).map_err(|e| format!("{}: {e}", source.display()))?;
    let pack_id = load_sticker(conn, sticker_id)?.pack_id;
    let (_, dir) = open_pack_files(conn, library_dir, pack_id)?;
    let stickers = load_stickers(conn, pack_id)?;
    let old_file = stickers
        .iter()
        .find(|s| s.id == sticker_id)
        .map(|s| s.file_name.clone())
        .ok_or_else(|| format!("sticker {sticker_id} does not exist"))?;
    let temp = stage_copy(&dir, source)?;
    let slots: Vec<Slot> = stickers
        .iter()
        .map(|s| {
            if s.id == sticker_id {
                Slot { sticker_id: Some(s.id), file: SlotFile::Staged(temp.clone()), format, emoji_string: s.emoji_string.clone() }
            } else {
                Slot::keep(s)
            }
        })
        .collect();
    if let Err(e) = apply_new_order(conn, &dir, pack_id, &slots, &[], &[old_file]) {
        discard_staged(conn, &dir, pack_id, std::slice::from_ref(&temp));
        return Err(e);
    }
    load_sticker(conn, sticker_id)
}

impl From<String> for SendFailure {
    fn from(message: String) -> Self {
        SendFailure { message, file_errors: Vec::new() }
    }
}

/// Final-state report when the copies are committed but listing them failed
/// (SPEC §5, ADR-0004): originals are kept, nothing more is attempted.
fn saved_but_unlisted(read_err: &str) -> SendReport {
    SendReport {
        copied: vec![],
        originals_deleted: false,
        target_size_warning: None,
        unfinished: Some(format!(
            "the copies are saved but could not be listed ({read_err}); reopen the target pack to see them; originals were kept"
        )),
    }
}

/// The stickers a pack gained after its first `before`, plus its size warning.
fn copied_since(conn: &Connection, pack_id: i64, before: usize) -> Result<(Vec<Sticker>, Option<Warning>), String> {
    let all = load_stickers(conn, pack_id)?;
    let warning = pack_size_warning(all.len());
    Ok((all[before..].to_vec(), warning))
}

/// Send stickers to another pack (SPEC §5): the unified Duplicate/Move.
/// Two-phase: (1) copy and byte-verify EVERY selected sticker into the
/// target — any failure rolls back all copies and changes nothing; (2)
/// append the copies at the target's end in source order with their Emoji
/// Strings, then — only if `delete_originals` — delete the originals and
/// renumber the source. Missing stickers block the send. A delete-phase
/// failure, or a target append that committed but did not finish, is
/// reported in the `SendReport` (copies are safe), never silent.
pub fn send_to_pack(
    conn: &mut Connection,
    library_dir: &Path,
    sticker_ids: &[i64],
    target_pack_id: i64,
    delete_originals: bool,
) -> Result<SendReport, SendFailure> {
    let first = *sticker_ids.first().ok_or_else(|| "no stickers selected".to_string())?;
    let source_pack_id = load_sticker(conn, first)?.pack_id;
    if source_pack_id == target_pack_id {
        return Err("stickers cannot be sent to the pack they are in".to_string().into());
    }
    load_pack(conn, target_pack_id)?;
    let (_, source_dir) = open_pack_files(conn, library_dir, source_pack_id)?;
    let (_, target_dir) = open_pack_files(conn, library_dir, target_pack_id)?;
    // `select` keeps position order: copies follow source order.
    let (kept, selected) = select(load_stickers(conn, source_pack_id)?, source_pack_id, sticker_ids)?;

    let missing: Vec<FileError> = selected
        .iter()
        .map(|s| source_dir.join(&s.file_name))
        .filter(|path| !path.is_file())
        .map(|path| FileError { path, reason: "sticker is Missing; replace it before sending".to_string() })
        .collect();
    if !missing.is_empty() {
        return Err(SendFailure { message: "Missing stickers cannot be sent".to_string(), file_errors: missing });
    }

    // Phase 1: copy + verify all; roll back on any failure.
    let mut staged = Vec::new();
    let mut copy_errors = Vec::new();
    for sticker in &selected {
        let path = source_dir.join(&sticker.file_name);
        match stage_copy(&target_dir, &path) {
            Ok(temp) => staged.push(temp),
            Err(reason) => copy_errors.push(FileError { path, reason }),
        }
    }
    if !copy_errors.is_empty() {
        let _ = remove_names(&target_dir, &staged);
        return Err(SendFailure {
            message: "copying failed; nothing was changed".to_string(),
            file_errors: copy_errors,
        });
    }

    // Phase 2a: adopt the copies at the target's end.
    let target_existing = load_stickers(conn, target_pack_id)?;
    let mut slots: Vec<Slot> = target_existing.iter().map(Slot::keep).collect();
    slots.extend(selected.iter().zip(&staged).map(|(s, temp)| Slot {
        sticker_id: None,
        file: SlotFile::Staged(temp.clone()),
        format: s.format,
        emoji_string: s.emoji_string.clone(),
    }));
    if let Err(e) = apply_new_order(conn, &target_dir, target_pack_id, &slots, &[], &[]) {
        let unfinished = match has_pending_plan(conn, target_pack_id) {
            Ok(false) => {
                let _ = remove_names(&target_dir, &staged);
                return Err(format!("{e}; nothing was changed").into());
            }
            // Committed: the copies stand and finish the next time the target
            // pack is opened (ADR-0004), so this is a report, not a failure.
            Ok(true) => format!(
                "{e}; the copies are saved and finish the next time the target pack is opened; originals were kept"
            ),
            // Unknown: staged copies are kept; reopening the target recovers.
            Err(_) => format!(
                "{e}; could not confirm whether the change was saved - reopen the target pack to check; originals were kept"
            ),
        };
        return Ok(match copied_since(conn, target_pack_id, target_existing.len()) {
            Ok((copied, target_size_warning)) => {
                SendReport { copied, originals_deleted: false, unfinished: Some(unfinished), target_size_warning }
            }
            Err(read_err) => SendReport {
                copied: vec![],
                originals_deleted: false,
                target_size_warning: None,
                unfinished: Some(format!("{unfinished}; the copies could not be listed ({read_err})")),
            },
        });
    }
    let (copied, target_size_warning) = match copied_since(conn, target_pack_id, target_existing.len()) {
        Ok(listed) => listed,
        // Committed but unreportable: skip the delete phase (SPEC §5, ADR-0004).
        Err(read_err) => return Ok(saved_but_unlisted(&read_err)),
    };

    // Phase 2b: delete originals and renumber the source.
    let (originals_deleted, unfinished) = if delete_originals {
        let slots: Vec<Slot> = kept.iter().map(Slot::keep).collect();
        match apply_new_order(conn, &source_dir, source_pack_id, &slots, &selected, &[]) {
            Ok(()) => (true, None),
            Err(e) => {
                match has_pending_plan(conn, source_pack_id) {
                    Ok(true) => {
                        (true, Some(format!("{e}; the deletion is saved and finishes the next time the pack is opened")))
                    }
                    Ok(false) => (false, Some(format!("{e}; the originals were kept"))),
                    Err(_) => (
                        false,
                        Some(format!(
                            "{e}; could not confirm whether the change was saved - reopen the pack to check"
                        )),
                    ),
                }
            }
        }
    } else {
        (false, None)
    };

    Ok(SendReport { copied, originals_deleted, unfinished, target_size_warning })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::files::{is_temp, sticker_file_name};
    use crate::library::packs::{create_pack, pack_dir};
    use crate::library::schema::{load_pack, load_sticker, load_stickers, Pack};
    use rusqlite::params;
    use std::fs;

    use crate::library::test_images::{png, png_sized, tag_of, webp, webp_sized};
    use crate::limits::STICKER_SIDE;

    /// A Library plus a separate folder of source images to import.
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

        fn pack(&mut self, short_name: &str) -> Pack {
            create_pack(&mut self.conn, self.dir.path(), short_name, Some(short_name)).unwrap()
        }

        /// Write a source file; `name`'s extension picks PNG or WEBP bytes.
        fn source(&self, name: &str, tag: &str) -> PathBuf {
            let path = self.sources.path().join(name);
            let bytes = if name.to_ascii_lowercase().ends_with(".webp") { webp(tag) } else { png(tag) };
            fs::write(&path, bytes).unwrap();
            path
        }

        fn new_sticker(&self, name: &str, tag: &str, emoji: &str) -> NewSticker {
            NewSticker { path: self.source(name, tag), emoji_string: emoji.to_string() }
        }

        fn add(&mut self, pack_id: i64, items: &[NewSticker], at: Option<i64>) -> Result<AddOutcome, String> {
            add_stickers(&mut self.conn, self.dir.path(), pack_id, items, at)
        }

        /// Seed `tags` as PNG stickers (emoji = tag) and return them.
        fn seed(&mut self, pack_id: i64, tags: &[&str]) -> Vec<Sticker> {
            let items: Vec<NewSticker> = tags
                .iter()
                .map(|t| self.new_sticker(&format!("{t}.png"), t, t))
                .collect();
            self.add(pack_id, &items, None).unwrap().added
        }

        fn dir_of(&self, pack_id: i64) -> PathBuf {
            pack_dir(self.path(), &load_pack(&self.conn, pack_id).unwrap())
        }

        /// File tags in position order; None for a Missing slot.
        fn tags(&self, pack_id: i64) -> Vec<Option<String>> {
            let dir = self.dir_of(pack_id);
            load_stickers(&self.conn, pack_id)
                .unwrap()
                .iter()
                .map(|s| fs::read(dir.join(&s.file_name)).ok().map(|b| tag_of(&b)))
                .collect()
        }

        fn emojis(&self, pack_id: i64) -> Vec<String> {
            load_stickers(&self.conn, pack_id)
                .unwrap()
                .into_iter()
                .map(|s| s.emoji_string)
                .collect()
        }

        /// DB and folder agree (ADR-0003/0004): positions 1..N, names
        /// order-encoded, no stray files, temps, or pending journal.
        fn assert_consistent(&self, pack_id: i64) {
            let stickers = load_stickers(&self.conn, pack_id).unwrap();
            for (i, s) in stickers.iter().enumerate() {
                assert_eq!(s.position, i as i64 + 1, "positions not contiguous");
                assert_eq!(s.file_name, sticker_file_name(s.position, s.format));
            }
            let expected: Vec<&str> = stickers.iter().map(|s| s.file_name.as_str()).collect();
            for entry in fs::read_dir(self.dir_of(pack_id)).unwrap() {
                let name = entry.unwrap().file_name().to_string_lossy().into_owned();
                assert!(!is_temp(&name), "leftover temp {name}");
                assert!(expected.contains(&name.as_str()), "unexpected file {name}");
            }
            assert!(!crate::library::files::has_pending_plan(&self.conn, pack_id).unwrap());
        }

        /// Delete a sticker's file behind the app's back (desync).
        fn make_missing(&self, sticker: &Sticker) {
            fs::remove_file(self.dir_of(sticker.pack_id).join(&sticker.file_name)).unwrap();
        }
    }

    fn some(tags: &[&str]) -> Vec<Option<String>> {
        tags.iter().map(|t| Some(t.to_string())).collect()
    }

    // ---- Warnings ----

    #[test]
    fn emoji_are_counted_as_people_see_them() {
        assert_eq!(emoji_count(""), 0);
        assert_eq!(emoji_count("😀"), 1);
        assert_eq!(emoji_count("😀🎉"), 2);
        assert_eq!(emoji_count("👍🏽"), 1, "skin tone modifier");
        assert_eq!(emoji_count("👨‍👩‍👧"), 1, "ZWJ family");
        assert_eq!(emoji_count("🇺🇦"), 1, "flag");
        assert_eq!(emoji_count(" 😀 "), 1, "whitespace is not an emoji");
    }

    #[test]
    fn emoji_string_warns_outside_one_to_twenty() {
        assert_eq!(emoji_warning(""), Some(Warning::EmojiCount { count: 0 }));
        assert_eq!(emoji_warning("😀"), None);
        assert_eq!(emoji_warning(&"😀".repeat(20)), None);
        assert_eq!(emoji_warning(&"😀".repeat(21)), Some(Warning::EmojiCount { count: 21 }));
    }

    #[test]
    fn pack_size_warns_above_one_hundred_twenty() {
        assert_eq!(pack_size_warning(0), None);
        assert_eq!(pack_size_warning(120), None);
        assert_eq!(pack_size_warning(121), Some(Warning::PackSize { count: 121 }));
    }

    #[test]
    fn warnings_serialize_with_a_kind_tag() {
        let json = serde_json::to_value(Warning::PackSize { count: 121 }).unwrap();
        assert_eq!(json["kind"], "packSize");
        assert_eq!(json["count"], 121);
    }

    // ---- File validation ----

    #[test]
    fn sticker_files_must_be_png_or_webp_within_the_size_limit() {
        let lib = Lib::new();
        assert_eq!(validate_sticker_file(&lib.source("a.png", "x")).unwrap(), Format::Png);
        assert_eq!(validate_sticker_file(&lib.source("b.WEBP", "x")).unwrap(), Format::Webp);
        // Padding after the image data makes a valid image exactly the limit, or one byte over.
        let padded = |extra: usize| {
            let image = png("");
            [image.clone(), vec![0u8; MAX_STICKER_BYTES as usize - image.len() + extra]].concat()
        };
        let big = lib.sources.path().join("big.png");
        fs::write(&big, padded(1)).unwrap();
        let err = validate_sticker_file(&big).unwrap_err();
        assert!(err.contains(&format!("{STICKER_MAX_KB} KB")), "unexpected error: {err}");
        let at_limit = lib.sources.path().join("limit.png");
        fs::write(&at_limit, padded(0)).unwrap();
        assert!(validate_sticker_file(&at_limit).is_ok());
    }

    #[test]
    fn sticker_files_need_one_side_exactly_the_sticker_side() {
        let lib = Lib::new();
        let side = STICKER_SIDE;
        let write = |name: &str, bytes: Vec<u8>| {
            let path = lib.sources.path().join(name);
            fs::write(&path, bytes).unwrap();
            path
        };
        // Longest side exactly the sticker side, either orientation, PNG or WEBP.
        for (w, h) in [(side, side), (side, 1), (1, side), (side, side - 1)] {
            assert!(validate_sticker_file(&write("ok.png", png_sized(w, h, ""))).is_ok(), "{w}x{h}");
            assert!(validate_sticker_file(&write("ok.webp", webp_sized(w, h, ""))).is_ok(), "{w}x{h}");
        }
        // Too small on both sides, or a side above the limit.
        for (w, h) in [(side - 1, side - 1), (side + 1, side), (side, side + 1), (1, 1)] {
            let err = validate_sticker_file(&write("bad.png", png_sized(w, h, ""))).unwrap_err();
            assert!(err.contains(&format!("{w}×{h}")), "unexpected error: {err}");
            assert!(err.contains(&format!("exactly {side} px")), "unexpected error: {err}");
            assert!(validate_sticker_file(&write("bad.webp", webp_sized(w, h, ""))).is_err());
        }
        // Truncated image data after a valid signature: the size cannot be read.
        assert!(validate_sticker_file(&write("cut.png", png("")[..12].to_vec())).is_err());
        assert!(sticker_dimensions_ok(side, 3));
        assert!(!sticker_dimensions_ok(side + 1, 3));
    }

    #[test]
    fn imports_and_replacements_enforce_the_dimension_rule() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let wrong = lib.sources.path().join("small.png");
        fs::write(&wrong, png_sized(STICKER_SIDE / 2, STICKER_SIDE / 2, "")).unwrap();
        let items = [
            lib.new_sticker("a.png", "A", ""),
            NewSticker { path: wrong.clone(), emoji_string: String::new() },
        ];
        let outcome = lib.add(pack.id, &items, None).unwrap();
        assert_eq!(outcome.added.len(), 1);
        assert_eq!(outcome.rejected[0].path, wrong);
        let sticker = outcome.added[0].clone();
        let err = replace_sticker_file(&mut lib.conn, lib.dir.path(), sticker.id, &wrong).unwrap_err();
        assert!(err.contains("px"), "unexpected error: {err}");
        assert_eq!(lib.tags(pack.id), some(&["A"]));
        lib.assert_consistent(pack.id);
    }

    #[test]
    fn sticker_file_validation_rejects_wrong_types_and_content() {
        let lib = Lib::new();
        let gif = lib.sources.path().join("a.gif");
        fs::write(&gif, b"GIF89a").unwrap();
        assert!(validate_sticker_file(&gif).is_err());
        let no_ext = lib.sources.path().join("noext");
        fs::write(&no_ext, png("x")).unwrap();
        assert!(validate_sticker_file(&no_ext).is_err());
        // Extension says PNG, content is WEBP (or a JPEG): rejected.
        let liar = lib.sources.path().join("liar.png");
        fs::write(&liar, webp("x")).unwrap();
        assert!(validate_sticker_file(&liar).unwrap_err().contains("PNG"));
        let jpeg = lib.sources.path().join("photo.webp");
        fs::write(&jpeg, b"\xff\xd8\xff\xe0 jpeg").unwrap();
        assert!(validate_sticker_file(&jpeg).is_err());
        assert!(validate_sticker_file(&lib.sources.path().join("absent.png")).is_err());
        assert!(validate_sticker_file(lib.sources.path()).is_err());
    }

    // ---- Add / insert ----

    #[test]
    fn add_appends_with_order_encoded_names_and_mixed_formats() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let items = [
            lib.new_sticker("first.png", "A", "😀"),
            lib.new_sticker("second.webp", "B", ""),
        ];
        let outcome = lib.add(pack.id, &items, None).unwrap();
        assert!(outcome.rejected.is_empty());
        assert_eq!(outcome.pack_size_warning, None);
        let names: Vec<&str> = outcome.added.iter().map(|s| s.file_name.as_str()).collect();
        assert_eq!(names, ["001.png", "002.webp"]);
        assert_eq!(outcome.added[1].format, Format::Webp);
        assert_eq!(lib.tags(pack.id), some(&["A", "B"]));
        assert_eq!(lib.emojis(pack.id), ["😀", ""]);
        // Sources are copied, not moved.
        assert!(items[0].path.is_file());
        lib.assert_consistent(pack.id);
    }

    #[test]
    fn insert_at_a_position_renumbers_the_files_after_it() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        lib.seed(pack.id, &["A", "B", "C"]);
        let new = [lib.new_sticker("n.webp", "N", "🆕")];
        let outcome = lib.add(pack.id, &new, Some(2)).unwrap();
        assert_eq!(outcome.added[0].position, 2);
        assert_eq!(outcome.added[0].file_name, "002.webp");
        assert_eq!(lib.tags(pack.id), some(&["A", "N", "B", "C"]));
        assert_eq!(lib.emojis(pack.id), ["A", "🆕", "B", "C"]);
        lib.assert_consistent(pack.id);
    }

    #[test]
    fn add_rejects_invalid_files_per_file_and_adds_the_rest_in_order() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let gif = lib.sources.path().join("bad.gif");
        fs::write(&gif, b"GIF89a").unwrap();
        let items = [
            lib.new_sticker("one.png", "1", ""),
            NewSticker { path: gif.clone(), emoji_string: String::new() },
            lib.new_sticker("two.png", "2", ""),
        ];
        let outcome = lib.add(pack.id, &items, None).unwrap();
        assert_eq!(outcome.added.len(), 2);
        assert_eq!(outcome.rejected.len(), 1);
        assert_eq!(outcome.rejected[0].path, gif);
        assert_eq!(lib.tags(pack.id), some(&["1", "2"]));
        lib.assert_consistent(pack.id);
    }

    #[test]
    fn add_out_of_range_position_changes_nothing() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        lib.seed(pack.id, &["A"]);
        for at in [0, 3, -1] {
            let item = [lib.new_sticker("n.png", "N", "")];
            assert!(lib.add(pack.id, &item, Some(at)).is_err(), "accepted at={at}");
        }
        assert_eq!(lib.tags(pack.id), some(&["A"]));
        lib.assert_consistent(pack.id);
        assert!(lib.add(999, &[lib.new_sticker("n.png", "N", "")], None).is_err());
    }

    #[test]
    fn going_past_one_hundred_twenty_warns_but_adds() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let tags: Vec<String> = (1..=120).map(|i| format!("s{i}")).collect();
        let refs: Vec<&str> = tags.iter().map(String::as_str).collect();
        lib.seed(pack.id, &refs);
        let outcome = lib.add(pack.id, &[lib.new_sticker("x.png", "X", "")], None).unwrap();
        assert_eq!(outcome.pack_size_warning, Some(Warning::PackSize { count: 121 }));
        assert_eq!(outcome.added[0].file_name, "121.png");
        lib.assert_consistent(pack.id);
    }

    #[test]
    fn add_refuses_when_a_foreign_file_sits_on_the_new_name() {
        // 002.png was renamed to 004.png outside the app; appending would
        // commit 004.png over it and wedge every later recovery.
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        lib.seed(pack.id, &["A", "B", "C"]);
        let dir = lib.dir_of(pack.id);
        fs::rename(dir.join("002.png"), dir.join("004.png")).unwrap();
        let snapshot = |lib: &Lib| -> Vec<(i64, i64, String)> {
            load_stickers(&lib.conn, pack.id)
                .unwrap()
                .into_iter()
                .map(|s| (s.id, s.position, s.file_name))
                .collect()
        };
        let before = snapshot(&lib);
        let err = lib.add(pack.id, &[lib.new_sticker("n.png", "N", "")], None).unwrap_err();
        assert!(err.contains("004.png") && err.contains("outside the app"), "unexpected error: {err}");
        assert!(!crate::library::files::has_pending_plan(&lib.conn, pack.id).unwrap());
        assert_eq!(snapshot(&lib), before);
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["001.png", "003.png", "004.png"], "staged temps must be gone");
        assert_eq!(tag_of(&fs::read(dir.join("004.png")).unwrap()), "B", "foreign file untouched");
        // Once the owner moves the file away, the add goes through.
        fs::remove_file(dir.join("004.png")).unwrap();
        lib.add(pack.id, &[lib.new_sticker("n.png", "N", "")], None).unwrap();
        assert_eq!(lib.tags(pack.id), vec![Some("A".into()), None, Some("C".into()), Some("N".into())]);
        lib.assert_consistent(pack.id);
    }

    // ---- Reorder ----

    #[test]
    fn reorder_moves_one_sticker_and_renames_files_to_match() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let s = lib.seed(pack.id, &["A", "B", "C", "D"]);
        let order = reorder_sticker(&mut lib.conn, lib.dir.path(), s[3].id, 1).unwrap();
        assert_eq!(order[0].id, s[3].id);
        assert_eq!(lib.tags(pack.id), some(&["D", "A", "B", "C"]));
        assert_eq!(lib.emojis(pack.id), ["D", "A", "B", "C"]);
        reorder_sticker(&mut lib.conn, lib.dir.path(), s[3].id, 4).unwrap();
        assert_eq!(lib.tags(pack.id), some(&["A", "B", "C", "D"]));
        lib.assert_consistent(pack.id);
    }

    #[test]
    fn reorder_carries_a_missing_slot_without_a_file() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let s = lib.seed(pack.id, &["A", "B", "C"]);
        lib.make_missing(&s[0]);
        reorder_sticker(&mut lib.conn, lib.dir.path(), s[0].id, 3).unwrap();
        assert_eq!(lib.tags(pack.id), vec![Some("B".into()), Some("C".into()), None]);
        assert_eq!(load_sticker(&lib.conn, s[0].id).unwrap().position, 3);
    }

    #[test]
    fn reorder_rejects_out_of_range_positions() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let s = lib.seed(pack.id, &["A", "B"]);
        for to in [0, 3] {
            assert!(reorder_sticker(&mut lib.conn, lib.dir.path(), s[0].id, to).is_err());
        }
        assert!(reorder_sticker(&mut lib.conn, lib.dir.path(), 999, 1).is_err());
        assert_eq!(lib.tags(pack.id), some(&["A", "B"]));
    }

    // ---- Delete ----

    #[test]
    fn delete_removes_files_and_renumbers_to_fill_the_gaps() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let s = lib.seed(pack.id, &["A", "B", "C", "D"]);
        let left = delete_stickers(&mut lib.conn, lib.dir.path(), pack.id, &[s[0].id, s[2].id]).unwrap();
        assert_eq!(left.len(), 2);
        assert_eq!(lib.tags(pack.id), some(&["B", "D"]));
        lib.assert_consistent(pack.id);
    }

    #[test]
    fn deleting_a_missing_slot_renumbers_the_pack() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let s = lib.seed(pack.id, &["A", "B", "C"]);
        lib.make_missing(&s[1]);
        delete_stickers(&mut lib.conn, lib.dir.path(), pack.id, &[s[1].id]).unwrap();
        assert_eq!(lib.tags(pack.id), some(&["A", "C"]));
        lib.assert_consistent(pack.id);
    }

    #[test]
    fn delete_rejects_empty_or_foreign_selections() {
        let mut lib = Lib::new();
        let p = lib.pack("p");
        let q = lib.pack("q");
        lib.seed(p.id, &["A"]);
        let foreign = lib.seed(q.id, &["Z"]);
        assert!(delete_stickers(&mut lib.conn, lib.dir.path(), p.id, &[]).is_err());
        assert!(delete_stickers(&mut lib.conn, lib.dir.path(), p.id, &[foreign[0].id]).is_err());
        assert!(delete_stickers(&mut lib.conn, lib.dir.path(), p.id, &[999]).is_err());
        assert_eq!(lib.tags(p.id), some(&["A"]));
        assert_eq!(lib.tags(q.id), some(&["Z"]));
    }

    // ---- Emoji ----

    #[test]
    fn emoji_string_is_stored_exactly() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let s = lib.seed(pack.id, &["A"]);
        let edited = set_emoji_string(&lib.conn, s[0].id, "👨‍👩‍👧🎉").unwrap();
        assert_eq!(edited.emoji_string, "👨‍👩‍👧🎉");
        assert_eq!(emoji_warning(&edited.emoji_string), None);
        assert_eq!(set_emoji_string(&lib.conn, s[0].id, "").unwrap().emoji_string, "");
        assert!(set_emoji_string(&lib.conn, 999, "😀").is_err());
    }

    // ---- Replace ----

    #[test]
    fn replace_keeps_identity_position_and_emoji_and_may_change_format() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let s = lib.seed(pack.id, &["A", "B", "C"]);
        let src = lib.source("new.webp", "B2");
        let replaced = replace_sticker_file(&mut lib.conn, lib.dir.path(), s[1].id, &src).unwrap();
        assert_eq!(replaced.id, s[1].id);
        assert_eq!(replaced.position, 2);
        assert_eq!(replaced.emoji_string, "B");
        assert_eq!(replaced.format, Format::Webp);
        assert_eq!(replaced.file_name, "002.webp");
        assert_eq!(lib.tags(pack.id), some(&["A", "B2", "C"]));
        lib.assert_consistent(pack.id);
        // Same format: overwrites in place.
        let src = lib.source("again.webp", "B3");
        replace_sticker_file(&mut lib.conn, lib.dir.path(), s[1].id, &src).unwrap();
        assert_eq!(lib.tags(pack.id), some(&["A", "B3", "C"]));
        lib.assert_consistent(pack.id);
    }

    #[test]
    fn replacing_a_missing_sticker_restores_its_file() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let s = lib.seed(pack.id, &["A", "B"]);
        lib.make_missing(&s[0]);
        let src = lib.source("fix.png", "A2");
        replace_sticker_file(&mut lib.conn, lib.dir.path(), s[0].id, &src).unwrap();
        assert_eq!(lib.tags(pack.id), some(&["A2", "B"]));
        lib.assert_consistent(pack.id);
    }

    #[test]
    fn replace_with_an_invalid_file_changes_nothing() {
        let mut lib = Lib::new();
        let pack = lib.pack("p");
        let s = lib.seed(pack.id, &["A"]);
        let gif = lib.sources.path().join("x.gif");
        fs::write(&gif, b"GIF89a").unwrap();
        assert!(replace_sticker_file(&mut lib.conn, lib.dir.path(), s[0].id, &gif).is_err());
        assert_eq!(lib.tags(pack.id), some(&["A"]));
        lib.assert_consistent(pack.id);
    }

    // ---- Send to pack ----

    #[test]
    fn send_without_delete_duplicates_independent_copies_in_source_order() {
        let mut lib = Lib::new();
        let src = lib.pack("src");
        let dst = lib.pack("dst");
        let s = lib.seed(src.id, &["A", "B", "C"]);
        lib.seed(dst.id, &["X"]);
        // Selection order does not matter: copies follow source order.
        let report = send_to_pack(&mut lib.conn, lib.dir.path(), &[s[2].id, s[0].id], dst.id, false).unwrap();
        assert!(!report.originals_deleted);
        assert_eq!(report.unfinished, None);
        assert_eq!(report.copied.len(), 2);
        assert_eq!(lib.tags(dst.id), some(&["X", "A", "C"]));
        assert_eq!(lib.emojis(dst.id), ["X", "A", "C"]);
        assert_eq!(lib.tags(src.id), some(&["A", "B", "C"]));
        // Independent copies (ADR-0002): editing one leaves the other alone.
        set_emoji_string(&lib.conn, report.copied[0].id, "✏️").unwrap();
        assert_eq!(load_sticker(&lib.conn, s[0].id).unwrap().emoji_string, "A");
        lib.assert_consistent(src.id);
        lib.assert_consistent(dst.id);
    }

    #[test]
    fn send_with_delete_moves_and_renumbers_the_source() {
        let mut lib = Lib::new();
        let src = lib.pack("src");
        let dst = lib.pack("dst");
        let s = lib.seed(src.id, &["A", "B", "C", "D"]);
        let report = send_to_pack(&mut lib.conn, lib.dir.path(), &[s[0].id, s[2].id], dst.id, true).unwrap();
        assert!(report.originals_deleted);
        assert_eq!(report.unfinished, None);
        assert_eq!(lib.tags(dst.id), some(&["A", "C"]));
        // No gaps and no false Missing in the source afterwards.
        assert_eq!(lib.tags(src.id), some(&["B", "D"]));
        lib.assert_consistent(src.id);
        lib.assert_consistent(dst.id);
    }

    #[test]
    fn send_is_blocked_by_a_missing_sticker() {
        let mut lib = Lib::new();
        let src = lib.pack("src");
        let dst = lib.pack("dst");
        let s = lib.seed(src.id, &["A", "B"]);
        lib.make_missing(&s[1]);
        let failure = send_to_pack(&mut lib.conn, lib.dir.path(), &[s[0].id, s[1].id], dst.id, true).unwrap_err();
        assert_eq!(failure.file_errors.len(), 1);
        assert!(failure.file_errors[0].reason.contains("Missing"));
        assert!(lib.tags(dst.id).is_empty());
        assert_eq!(lib.tags(src.id), vec![Some("A".into()), None]);
    }

    #[test]
    fn send_rejects_bad_selections() {
        let mut lib = Lib::new();
        let p = lib.pack("p");
        let q = lib.pack("q");
        let a = lib.seed(p.id, &["A"]);
        let z = lib.seed(q.id, &["Z"]);
        let dir = lib.dir.path().to_path_buf();
        assert!(send_to_pack(&mut lib.conn, &dir, &[], q.id, false).is_err());
        assert!(send_to_pack(&mut lib.conn, &dir, &[a[0].id], p.id, false).is_err(), "same pack");
        assert!(send_to_pack(&mut lib.conn, &dir, &[a[0].id, z[0].id], q.id, false).is_err(), "mixed packs");
        assert!(send_to_pack(&mut lib.conn, &dir, &[a[0].id], 999, false).is_err());
        assert!(send_to_pack(&mut lib.conn, &dir, &[999], q.id, false).is_err());
        assert_eq!(lib.tags(p.id), some(&["A"]));
        assert_eq!(lib.tags(q.id), some(&["Z"]));
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_rolls_back_every_copy_and_keeps_the_originals() {
        use std::os::unix::fs::PermissionsExt;
        let mut lib = Lib::new();
        let src = lib.pack("src");
        let dst = lib.pack("dst");
        let s = lib.seed(src.id, &["A", "B", "C"]);
        let unreadable = lib.dir_of(src.id).join(&s[1].file_name);
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();
        let result = send_to_pack(&mut lib.conn, lib.dir.path(), &[s[0].id, s[1].id, s[2].id], dst.id, true);
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o644)).unwrap();
        let failure = result.unwrap_err();
        assert_eq!(failure.file_errors.len(), 1);
        assert_eq!(failure.file_errors[0].path, unreadable);
        assert!(lib.tags(dst.id).is_empty());
        lib.assert_consistent(dst.id);
        assert_eq!(lib.tags(src.id), some(&["A", "B", "C"]));
        lib.assert_consistent(src.id);
    }

    #[cfg(unix)]
    #[test]
    fn a_delete_phase_failure_reports_the_final_state() {
        use std::os::unix::fs::PermissionsExt;
        let mut lib = Lib::new();
        let src = lib.pack("src");
        let dst = lib.pack("dst");
        let s = lib.seed(src.id, &["A", "B", "C"]);
        // Copies land in dst; the source folder refuses the delete renames.
        let src_dir = lib.dir_of(src.id);
        fs::set_permissions(&src_dir, fs::Permissions::from_mode(0o555)).unwrap();
        let result = send_to_pack(&mut lib.conn, lib.dir.path(), &[s[0].id], dst.id, true);
        fs::set_permissions(&src_dir, fs::Permissions::from_mode(0o755)).unwrap();
        let report = result.unwrap();
        assert_eq!(report.copied.len(), 1);
        assert_eq!(lib.tags(dst.id), some(&["A"]));
        let error = report.unfinished.expect("delete failure must be reported");
        // The deletion committed before the files moved: it stands and
        // completes on the next pack open (ADR-0004 roll-forward).
        assert!(report.originals_deleted, "{error}");
        crate::library::files::recover(&lib.conn, &src_dir, src.id).unwrap();
        assert_eq!(lib.tags(src.id), some(&["B", "C"]));
        lib.assert_consistent(src.id);
    }

    #[test]
    fn a_delete_phase_refused_before_commit_keeps_the_originals() {
        let mut lib = Lib::new();
        let src = lib.pack("src");
        let dst = lib.pack("dst");
        let items = [
            lib.new_sticker("a.png", "A", "A"),
            lib.new_sticker("b.webp", "B", "B"),
            lib.new_sticker("c.png", "C", "C"),
        ];
        let s = lib.add(src.id, &items, None).unwrap().added;
        // Deleting 001.png renumbers 002.webp to 001.webp, which a foreign
        // file occupies: the pre-commit guard refuses the whole plan.
        let src_dir = lib.dir_of(src.id);
        let foreign = src_dir.join("001.webp");
        fs::write(&foreign, b"foreign").unwrap();

        let report = send_to_pack(&mut lib.conn, lib.dir.path(), &[s[0].id], dst.id, true).unwrap();
        assert_eq!(report.copied.len(), 1);
        assert!(!report.originals_deleted);
        let unfinished = report.unfinished.expect("refusal must be reported");
        assert!(unfinished.contains("originals were kept"), "{unfinished}");
        assert_eq!(lib.tags(dst.id), some(&["A"]));
        lib.assert_consistent(dst.id);

        let names: Vec<String> =
            load_stickers(&lib.conn, src.id).unwrap().into_iter().map(|s| s.file_name).collect();
        assert_eq!(names, ["001.png", "002.webp", "003.png"]);
        assert!(!crate::library::files::has_pending_plan(&lib.conn, src.id).unwrap());
        assert_eq!(fs::read(&foreign).unwrap(), b"foreign");
        for entry in fs::read_dir(&src_dir).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(!is_temp(&name), "leftover temp {name}");
        }
        assert_eq!(fs::read_dir(&src_dir).unwrap().count(), 4);
    }

    // ---- Pending folder renames ----

    #[test]
    fn sticker_operations_settle_a_pending_folder_rename_first() {
        let mut lib = Lib::new();
        let pack = lib.pack("before");
        lib.seed(pack.id, &["A"]);
        lib.conn
            .execute(
                "UPDATE packs SET short_name = 'after', folder_rename_from = 'before' WHERE id = ?1",
                params![pack.id],
            )
            .unwrap();
        lib.add(pack.id, &[lib.new_sticker("b.png", "B", "")], None).unwrap();
        assert!(!lib.path().join("before").exists());
        assert_eq!(lib.tags(pack.id), some(&["A", "B"]));
        lib.assert_consistent(pack.id);
    }
}

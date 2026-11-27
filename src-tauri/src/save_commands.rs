//! The Editor's save command (SPEC §6 Save, SPM-10): flatten and encode in
//! Rust (editor/save.rs, editor/encode.rs), then write through the Library
//! core (`add_stickers` / `replace_sticker_file` for stickers,
//! `packs::set_thumbnail` for the thumbnail target, SPM-12), which validates
//! the file once more before it enters the pack. The typed TS wrapper is
//! `saveImage` in src/editor/api.ts.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{env, fs, process};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::editor::encode::{EncodeOutcome, Encoded, SaveFormat};
use crate::editor::save::{render_for_save, ConstraintSet, SaveDoc};
use crate::library::packs;
use crate::library::schema::{Pack, Sticker};
use crate::library::stickers::{self, NewSticker};
use crate::commands::style_emoji_fonts;
use crate::pack_commands::{with_library, LibraryLock};
use crate::{editor, SharedConfig};

/// Where a save goes: a sticker slot, or the pack's thumbnail (SPM-12). A
/// sticker slot save is held to the sticker constraint set, a thumbnail save
/// to the thumbnail one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SaveTarget {
    /// A new sticker at the end of the pack, with an empty Emoji String.
    Append { pack_id: i64 },
    /// The image of an existing sticker, keeping its position and Emoji
    /// String (the replace-in-slot path, consumed by SPM-11).
    Replace { sticker_id: i64 },
    /// The pack's thumbnail slot (SPM-12): the pack's unnumbered thumbnail
    /// file, replacing any existing one.
    Thumbnail { pack_id: i64 },
}

/// The save request's header: the document, the chosen format and target.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMeta {
    #[serde(flatten)]
    pub doc: SaveDoc,
    pub format: SaveFormat,
    pub target: SaveTarget,
    /// The Emoji String a NEW sticker gets (SPEC §6 Layout, SPM-15): the
    /// Emoji tab's staged value, empty for none. A replace and a thumbnail
    /// save ignore it. Warn-only, never blocked (SPEC §3, §7).
    #[serde(default)]
    pub emoji_string: String,
}

/// What a save did; mirrors `SaveOutcome` in src/editor/api.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SaveOutcome {
    /// Written: the sticker as it now is, the file's size, and the lossy
    /// WEBP quality used (None: lossless).
    Saved { sticker: Sticker, bytes: usize, quality: Option<u8> },
    /// Written (a thumbnail save, SPM-12): the pack as it now is (thumbnail
    /// set), the file's size, and the lossy WEBP quality used (None: lossless).
    SavedThumbnail { pack: Pack, bytes: usize, quality: Option<u8> },
    /// Nothing was written: even the smallest encoding is over the cap.
    TooLarge { format: SaveFormat, bytes: usize, max_kilobytes: u64 },
}

/// Header carrying the save request's `SaveMeta` (JSON); raster pixels
/// travel as the raw body, as for merge.
pub const SAVE_HEADER: &str = "x-save-image";

/// Save the Editor's document (SPEC §6). Request: raw body = the raster
/// layers' RGBA bytes concatenated bottom to top, header `x-save-image` =
/// `SaveMeta`. A canvas that misses the constraint set is refused (Err);
/// an image over the size cap is `TooLarge` and nothing is written.
#[tauri::command(async)]
pub fn editor_save_image(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
    config_state: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<SaveOutcome, String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(body) => body,
        _ => return Err("save request must carry raw bytes".to_string()),
    };
    let header = request
        .headers()
        .get(SAVE_HEADER)
        .ok_or_else(|| format!("the request is missing the {SAVE_HEADER} header"))?
        .to_str()
        .map_err(|e| format!("the {SAVE_HEADER} header is not text: {e}"))?;
    let meta: SaveMeta = serde_json::from_str(header).map_err(|e| format!("the save header is invalid: {e}"))?;
    // The target picks the constraint set (SPEC §6-7): a thumbnail save is
    // held to exactly the thumbnail side square within its own cap.
    let set = match meta.target {
        SaveTarget::Thumbnail { .. } => ConstraintSet::Thumbnail,
        _ => ConstraintSet::Sticker,
    };
    let cap_kb = save_cap_kb(set);
    // The pixel work runs before taking the Library lock; a text layer
    // rasterises with the style's emoji chain (SPM-20). The helper drops
    // the config guard before returning: with_library re-locks the config,
    // so holding it here would deadlock every save.
    let emoji = style_emoji_fonts(&app, &config_state)?;
    let encoded = match render_for_save(set, &meta.doc, body, editor::text::system_fonts(), &emoji, meta.format, cap_kb)? {
        EncodeOutcome::Fits(encoded) => encoded,
        // The cap actually used, so the dialog names it (the override's, in a debug build).
        EncodeOutcome::TooLarge { format, smallest } => {
            return Ok(SaveOutcome::TooLarge { format, bytes: smallest, max_kilobytes: cap_kb })
        }
    };
    with_library(&config_state, &lock, |conn, dir| match meta.target {
        SaveTarget::Thumbnail { pack_id } => {
            let pack = write_thumbnail(conn, dir, pack_id, &encoded)?;
            // The file is new: the Pack Manager reads it once instead of trusting its last check.
            lock.memo().forget_thumbnail(pack_id);
            Ok(SaveOutcome::SavedThumbnail { pack, bytes: encoded.bytes.len(), quality: encoded.quality })
        }
        _ => {
            let sticker = write_sticker(conn, dir, meta.target, &encoded, &meta.emoji_string)?;
            if let SaveTarget::Replace { sticker_id } = meta.target {
                // The file is new: the Pack Manager reads it again instead of trusting its last check.
                lock.memo().forget_sticker(sticker.pack_id, sticker_id);
            }
            Ok(SaveOutcome::Saved { sticker, bytes: encoded.bytes.len(), quality: encoded.quality })
        }
    })
}

/// Environment variable of the dev-only size-cap override (debug builds only).
#[cfg(any(debug_assertions, test))]
const DEBUG_CAP_VAR: &str = "SPM_DEBUG_SAVE_CAP_KB";

/// The size cap a save is held to, in KB: the constraint set's. In a debug
/// build (`bun run tauri dev`), `SPM_DEBUG_SAVE_CAP_KB` set to a whole number
/// of KB replaces it, so the owner can reach the "even WEBP is too large"
/// dialog by hand (SPEC §6 Save, dev-only test hook). Release builds compile
/// the override out entirely. The webview's checks keep the real limits.
fn save_cap_kb(set: ConstraintSet) -> u64 {
    #[cfg(debug_assertions)]
    if let Ok(raw) = std::env::var(DEBUG_CAP_VAR) {
        match parse_cap_kb(&raw) {
            Ok(kb) => return kb,
            Err(e) => eprintln!("warning: ignoring {DEBUG_CAP_VAR}={raw:?}: {e}"),
        }
    }
    set.max_kilobytes()
}

/// The override's value: a whole number of KB, at least 1.
#[cfg(any(debug_assertions, test))]
fn parse_cap_kb(raw: &str) -> Result<u64, String> {
    match raw.trim().parse::<u64>() {
        Ok(0) => Err("the cap must be at least 1 KB".to_string()),
        Ok(kb) => Ok(kb),
        Err(e) => Err(format!("not a whole number of KB ({e})")),
    }
}

/// Write encoded bytes into the Library at `target`. The core copies from a
/// file, so the bytes go to a temporary file first (removed afterwards); the
/// core then checks it as a sticker (format, size, dimensions) like any
/// drop-in, and appends it with an order-encoded name (ADR-0003) or puts it
/// in its slot. `emoji` is the new sticker's Emoji String, stripped to its
/// emoji by `stickers::strip_to_emoji` like `stickers::set_emoji_string`
/// (SPEC §5); a replace keeps the sticker's own string and ignores it.
pub fn write_sticker(
    conn: &mut Connection,
    library_dir: &Path,
    target: SaveTarget,
    encoded: &Encoded,
    emoji: &str,
) -> Result<Sticker, String> {
    let temp = TempFile::write(encoded.format.as_str(), &encoded.bytes)?;
    match target {
        SaveTarget::Append { pack_id } => {
            let emoji_string = stickers::strip_to_emoji(emoji);
            let new = [NewSticker { path: temp.0.clone(), emoji_string }];
            let mut outcome = stickers::add_stickers(conn, library_dir, pack_id, &new, None)?;
            if let Some(rejected) = outcome.rejected.pop() {
                return Err(format!("Not saved: the image {}.", rejected.reason));
            }
            outcome.added.pop().ok_or_else(|| "internal error: the saved sticker was not added".to_string())
        }
        SaveTarget::Replace { sticker_id } => stickers::replace_sticker_file(conn, library_dir, sticker_id, &temp.0),
        // The command branches on the target before this helper
        // (editor_save_image): a thumbnail save goes through write_thumbnail.
        SaveTarget::Thumbnail { .. } => Err("internal error: a thumbnail save is not a sticker save".to_string()),
    }
}

/// Write encoded bytes as a pack's thumbnail (SPM-12): the bytes go to a
/// temporary file, then the core checks it as a thumbnail (format, size,
/// exact dimensions) like any other and places it as the pack's unnumbered
/// `thumbnail.<ext>` file, replacing any existing one.
pub fn write_thumbnail(conn: &mut Connection, library_dir: &Path, pack_id: i64, encoded: &Encoded) -> Result<Pack, String> {
    let temp = TempFile::write(encoded.format.as_str(), &encoded.bytes)?;
    packs::set_thumbnail(conn, library_dir, pack_id, &temp.0)
}

/// A file in the OS temp folder, deleted when dropped.
struct TempFile(PathBuf);

impl TempFile {
    fn write(extension: &str, bytes: &[u8]) -> Result<TempFile, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = env::temp_dir().join(format!("stickerpack-save-{}-{n}.{extension}", process::id()));
        // Owned before writing, so a partial write is removed too.
        let file = TempFile(path);
        fs::write(&file.0, bytes).map_err(|e| format!("cannot write the image to a temporary file: {e}"))?;
        Ok(file)
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::encode::{encode_within, tests::noise};
    use crate::editor::Rgba;
    use crate::library;
    use crate::library::packs::create_pack;
    use crate::library::schema::{load_pack, load_stickers, Format};
    use crate::limits::{STICKER_MAX_KB, STICKER_SIDE, THUMBNAIL_MAX_KB, THUMBNAIL_SIDE};

    struct Lib {
        dir: tempfile::TempDir,
        conn: Connection,
    }

    impl Lib {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            library::create_fresh(dir.path()).unwrap();
            let conn = library::open(dir.path()).unwrap();
            Lib { dir, conn }
        }

        fn file(&self, pack: &str, name: &str) -> Vec<u8> {
            fs::read(self.dir.path().join(pack).join(name)).unwrap()
        }
    }

    fn encoded(image: &Rgba, format: SaveFormat) -> Encoded {
        match encode_within(image, format, usize::MAX).unwrap() {
            EncodeOutcome::Fits(e) => e,
            EncodeOutcome::TooLarge { .. } => unreachable!(),
        }
    }

    fn sticker_image(height: u32) -> Rgba {
        noise(STICKER_SIDE, height)
    }

    #[test]
    fn saves_append_at_the_pack_end_with_order_encoded_names() {
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "Cats", None).unwrap();
        let png = encoded(&sticker_image(8), SaveFormat::Png);
        let webp = encoded(&sticker_image(9), SaveFormat::Webp);
        let a = write_sticker(&mut lib.conn, lib.dir.path(), SaveTarget::Append { pack_id: pack.id }, &png, "").unwrap();
        let b = write_sticker(&mut lib.conn, lib.dir.path(), SaveTarget::Append { pack_id: pack.id }, &webp, "").unwrap();
        assert_eq!((a.position, a.file_name.as_str(), a.format), (1, "001.png", Format::Png));
        assert_eq!((b.position, b.file_name.as_str(), b.format), (2, "002.webp", Format::Webp));
        // No staged emoji: today's behaviour, an empty string flagged in the Pack Manager.
        assert!(a.emoji_string.is_empty());
        // The files are exactly the encoded bytes, and decode at their size.
        assert_eq!(lib.file("cats", "001.png"), png.bytes);
        assert_eq!(lib.file("cats", "002.webp"), webp.bytes);
        let back = image::load_from_memory(&lib.file("cats", "002.webp")).unwrap();
        assert_eq!((back.width(), back.height()), (STICKER_SIDE, 9));
    }

    #[test]
    fn a_new_sticker_saves_with_the_staged_emoji_string() {
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "Cats", None).unwrap();
        let append = SaveTarget::Append { pack_id: pack.id };
        // A staged Emoji String is stored as typed (warn-only counts, SPEC §3).
        let saved = write_sticker(&mut lib.conn, lib.dir.path(), append, &encoded(&sticker_image(4), SaveFormat::Png), "😀🎉").unwrap();
        assert_eq!(saved.emoji_string, "😀🎉");
        // Spaces are stripped like set_emoji_string does (SPEC §5).
        let spaced = write_sticker(&mut lib.conn, lib.dir.path(), append, &encoded(&sticker_image(5), SaveFormat::Png), " 😀 🎉 ").unwrap();
        assert_eq!(spaced.emoji_string, "😀🎉");
        assert_eq!(load_stickers(&lib.conn, pack.id).unwrap().len(), 2);
    }

    #[test]
    fn a_new_sticker_strips_non_emoji_like_an_emoji_edit_does() {
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "Cats", None).unwrap();
        let append = SaveTarget::Append { pack_id: pack.id };
        // The staged box may hold pasted words (owner decision 2026-11-27):
        // the stored string is the emoji alone.
        let typed = "cats 😀 and 🎉!";
        let saved = write_sticker(&mut lib.conn, lib.dir.path(), append, &encoded(&sticker_image(4), SaveFormat::Png), typed)
            .unwrap();
        assert_eq!(saved.emoji_string, "😀🎉");
        // One strip function behind both entry points, so the two cannot drift.
        let other =
            write_sticker(&mut lib.conn, lib.dir.path(), append, &encoded(&sticker_image(5), SaveFormat::Png), "").unwrap();
        let edited = stickers::set_emoji_string(&lib.conn, other.id, typed).unwrap();
        assert_eq!(edited.emoji_string, saved.emoji_string);
    }

    #[test]
    fn replace_keeps_the_slot_and_emoji_and_may_change_the_format() {
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "Dogs", None).unwrap();
        let append = SaveTarget::Append { pack_id: pack.id };
        let first =
            write_sticker(&mut lib.conn, lib.dir.path(), append, &encoded(&sticker_image(4), SaveFormat::Png), "").unwrap();
        write_sticker(&mut lib.conn, lib.dir.path(), append, &encoded(&sticker_image(5), SaveFormat::Png), "").unwrap();
        stickers::set_emoji_string(&lib.conn, first.id, "🐶").unwrap();
        let new = encoded(&sticker_image(6), SaveFormat::Webp);
        // A replace ignores the request's Emoji String: the sticker keeps its own (SPEC §6).
        let replaced = write_sticker(
            &mut lib.conn,
            lib.dir.path(),
            SaveTarget::Replace { sticker_id: first.id },
            &new,
            "🐱",
        )
        .unwrap();
        assert_eq!((replaced.id, replaced.position, replaced.emoji_string.as_str()), (first.id, 1, "🐶"));
        assert_eq!(replaced.file_name, "001.webp");
        assert_eq!(lib.file("dogs", "001.webp"), new.bytes);
        assert!(!lib.dir.path().join("dogs").join("001.png").exists());
        assert_eq!(load_stickers(&lib.conn, pack.id).unwrap().len(), 2);
    }

    #[test]
    fn the_core_refuses_a_non_sticker_even_if_encoding_let_it_through() {
        // Defence in depth: the Library core validates the written file too.
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "Birds", None).unwrap();
        let small = encoded(&noise(10, 10), SaveFormat::Png);
        let err =
            write_sticker(&mut lib.conn, lib.dir.path(), SaveTarget::Append { pack_id: pack.id }, &small, "").unwrap_err();
        assert!(err.starts_with("Not saved:"), "{err}");
        assert!(load_stickers(&lib.conn, pack.id).unwrap().is_empty());
    }

    #[test]
    fn the_debug_cap_override_takes_a_positive_whole_number_of_kb() {
        assert_eq!(parse_cap_kb("1"), Ok(1));
        assert_eq!(parse_cap_kb(" 40 "), Ok(40));
        assert!(parse_cap_kb("0").is_err());
        assert!(parse_cap_kb("-3").is_err());
        assert!(parse_cap_kb("1.5").is_err());
        assert!(parse_cap_kb("").is_err());
        assert!(parse_cap_kb("lots").is_err());
        // Unset (as in every test run), the constraint set's cap applies.
        if std::env::var(DEBUG_CAP_VAR).is_err() {
            assert_eq!(save_cap_kb(ConstraintSet::Sticker), STICKER_MAX_KB);
        }
    }

    #[test]
    fn the_temporary_file_is_removed() {
        let path = {
            let temp = TempFile::write("png", b"x").unwrap();
            assert!(temp.0.is_file());
            temp.0.clone()
        };
        assert!(!path.exists());
    }

    #[test]
    fn a_thumbnail_save_writes_the_unnumbered_file_and_reports_the_pack() {
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "Cats", None).unwrap();
        let png = encoded(&noise(THUMBNAIL_SIDE, THUMBNAIL_SIDE), SaveFormat::Png);
        let webp = encoded(&noise(THUMBNAIL_SIDE, THUMBNAIL_SIDE), SaveFormat::Webp);
        let saved = write_thumbnail(&mut lib.conn, lib.dir.path(), pack.id, &png).unwrap();
        assert_eq!(saved.thumbnail.as_deref(), Some("thumbnail.png"));
        // The file is exactly the encoded bytes, and decodes at its size.
        assert_eq!(lib.file("cats", "thumbnail.png"), png.bytes);
        let back = image::load_from_memory(&lib.file("cats", "thumbnail.png")).unwrap();
        assert_eq!((back.width(), back.height()), (THUMBNAIL_SIDE, THUMBNAIL_SIDE));
        // A WEBP save replaces the file (and the name) like a PNG one.
        let saved = write_thumbnail(&mut lib.conn, lib.dir.path(), pack.id, &webp).unwrap();
        assert_eq!(saved.thumbnail.as_deref(), Some("thumbnail.webp"));
        assert_eq!(lib.file("cats", "thumbnail.webp"), webp.bytes);
        assert!(!lib.dir.path().join("cats").join("thumbnail.png").exists());
        assert_eq!(load_pack(&lib.conn, pack.id).unwrap().thumbnail.as_deref(), Some("thumbnail.webp"));
    }

    #[test]
    fn a_wrong_sized_thumbnail_is_refused_before_anything_is_written() {
        use crate::editor::layers::LayerMeta;
        use crate::editor::placement::LayerTransform;
        // The command picks the thumbnail set for a thumbnail target
        // (editor_save_image); its size rule refuses before the Library is
        // ever touched.
        let fonts = crate::editor::text::system_fonts();
        let image = noise(THUMBNAIL_SIDE, THUMBNAIL_SIDE - 1);
        let doc = SaveDoc {
            width: THUMBNAIL_SIDE,
            height: THUMBNAIL_SIDE - 1,
            layers: vec![LayerMeta {
                width: THUMBNAIL_SIDE,
                height: THUMBNAIL_SIDE - 1,
                transform: LayerTransform::IDENTITY,
                text: None,
            }],
        };
        let err = render_for_save(ConstraintSet::Thumbnail, &doc, &image.pixels, fonts, &crate::editor::emoji::EmojiFonts::empty(), SaveFormat::Png, THUMBNAIL_MAX_KB).unwrap_err();
        assert!(err.starts_with("Not saved:"), "{err}");
        // And the core refuses a non-square file even if encoding let it through.
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "Birds", None).unwrap();
        let small = encoded(&noise(THUMBNAIL_SIDE, THUMBNAIL_SIDE - 1), SaveFormat::Png);
        let err = write_thumbnail(&mut lib.conn, lib.dir.path(), pack.id, &small).unwrap_err();
        assert!(err.contains("px"), "{err}");
        assert_eq!(load_pack(&lib.conn, pack.id).unwrap().thumbnail, None);
        assert!(lib.dir.path().join("birds").read_dir().unwrap().next().is_none());
    }

    #[test]
    fn thumbnail_targets_and_outcomes_round_trip_with_the_typescript_names() {
        let thumbnail: SaveTarget = serde_json::from_str(r#"{"kind":"thumbnail","packId":5}"#).unwrap();
        assert_eq!(thumbnail, SaveTarget::Thumbnail { pack_id: 5 });
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "Cats", None).unwrap();
        let saved_thumbnail =
            SaveOutcome::SavedThumbnail { pack: load_pack(&lib.conn, pack.id).unwrap(), bytes: 2048, quality: Some(80) };
        let json = serde_json::to_value(&saved_thumbnail).unwrap();
        assert_eq!(json["kind"], "savedThumbnail");
        assert_eq!(json["bytes"], 2048);
        assert_eq!(json["quality"], 80);
        assert_eq!(json["pack"]["shortName"], "cats");
        assert!(json["pack"].get("thumbnail").is_some(), "the pack fields serialize camelCase and flattened");
        let lossless = SaveOutcome::SavedThumbnail { pack: load_pack(&lib.conn, pack.id).unwrap(), bytes: 9, quality: None };
        assert_eq!(serde_json::to_value(&lossless).unwrap()["quality"], serde_json::json!(null));
    }

    #[test]
    fn request_and_outcome_json_match_the_typescript_names() {
        // Without the field (an older caller) the Emoji String defaults to empty: today's behaviour.
        let meta: SaveMeta = serde_json::from_str(&format!(
            r#"{{"width":{STICKER_SIDE},"height":3,"layers":[],"format":"webp","target":{{"kind":"replace","stickerId":7}}}}"#,
        ))
        .unwrap();
        assert_eq!((meta.doc.width, meta.doc.height, meta.format), (STICKER_SIDE, 3, SaveFormat::Webp));
        assert_eq!(meta.target, SaveTarget::Replace { sticker_id: 7 });
        assert_eq!(meta.emoji_string, "");
        let with_emoji: SaveMeta = serde_json::from_str(&format!(
            r#"{{"width":{STICKER_SIDE},"height":3,"layers":[],"format":"png","target":{{"kind":"append","packId":3}},"emojiString":"😀"}}"#,
        ))
        .unwrap();
        assert_eq!(with_emoji.target, SaveTarget::Append { pack_id: 3 });
        assert_eq!(with_emoji.emoji_string, "😀");
        let append: SaveTarget = serde_json::from_str(r#"{"kind":"append","packId":3}"#).unwrap();
        assert_eq!(append, SaveTarget::Append { pack_id: 3 });
        let too_large = SaveOutcome::TooLarge { format: SaveFormat::Png, bytes: 9, max_kilobytes: STICKER_MAX_KB };
        assert_eq!(
            serde_json::to_value(&too_large).unwrap(),
            serde_json::json!({"kind":"tooLarge","format":"png","bytes":9,"maxKilobytes":STICKER_MAX_KB})
        );
    }
}

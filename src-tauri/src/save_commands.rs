//! The Editor's save command (SPEC §6 Save, SPM-10): flatten and encode in
//! Rust (editor/save.rs, editor/encode.rs), then write through the Library
//! core (`add_stickers` / `replace_sticker_file`), which validates the file
//! once more as a sticker before it enters the pack. The typed TS wrapper is
//! `saveImage` in src/editor/api.ts.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{env, fs, process};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::editor::encode::{EncodeOutcome, Encoded, SaveFormat};
use crate::editor::save::{render_for_save, ConstraintSet, SaveDoc};
use crate::library::schema::Sticker;
use crate::library::stickers::{self, NewSticker};
use crate::pack_commands::{with_library, LibraryLock};
use crate::{editor, SharedConfig};

/// Where a save goes. Both are sticker slots, so a save is held to the
/// sticker constraint set; Thumbnail mode (SPM-12) adds its own target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SaveTarget {
    /// A new sticker at the end of the pack, with an empty Emoji String.
    Append { pack_id: i64 },
    /// The image of an existing sticker, keeping its position and Emoji
    /// String (the replace-in-slot path, consumed by SPM-11).
    Replace { sticker_id: i64 },
}

/// The save request's header: the document, the chosen format and target.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMeta {
    #[serde(flatten)]
    pub doc: SaveDoc,
    pub format: SaveFormat,
    pub target: SaveTarget,
}

/// What a save did; mirrors `SaveOutcome` in src/editor/api.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SaveOutcome {
    /// Written: the sticker as it now is, the file's size, and the lossy
    /// WEBP quality used (None: lossless).
    Saved { sticker: Sticker, bytes: usize, quality: Option<u8> },
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
    config: State<'_, SharedConfig>,
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
    // Every target is a sticker slot (see SaveTarget).
    let set = ConstraintSet::Sticker;
    // The pixel work runs before taking the Library lock.
    let encoded = match render_for_save(set, &meta.doc, body, editor::text::system_fonts(), meta.format)? {
        EncodeOutcome::Fits(encoded) => encoded,
        EncodeOutcome::TooLarge { format, smallest } => {
            return Ok(SaveOutcome::TooLarge { format, bytes: smallest, max_kilobytes: set.max_kilobytes() })
        }
    };
    with_library(&config, &lock, |conn, dir| {
        let sticker = write_sticker(conn, dir, meta.target, &encoded)?;
        if let SaveTarget::Replace { sticker_id } = meta.target {
            // The file is new: the Pack Manager reads it again instead of trusting its last check.
            lock.memo().forget_sticker(sticker.pack_id, sticker_id);
        }
        Ok(SaveOutcome::Saved { sticker, bytes: encoded.bytes.len(), quality: encoded.quality })
    })
}

/// Write encoded bytes into the Library at `target`. The core copies from a
/// file, so the bytes go to a temporary file first (removed afterwards); the
/// core then checks it as a sticker (format, size, dimensions) like any
/// drop-in, and appends it with an order-encoded name (ADR-0003) or puts it
/// in its slot.
pub fn write_sticker(conn: &mut Connection, library_dir: &Path, target: SaveTarget, encoded: &Encoded) -> Result<Sticker, String> {
    let temp = TempFile::write(encoded.format.as_str(), &encoded.bytes)?;
    match target {
        SaveTarget::Append { pack_id } => {
            let new = [NewSticker { path: temp.0.clone(), emoji_string: String::new() }];
            let mut outcome = stickers::add_stickers(conn, library_dir, pack_id, &new, None)?;
            if let Some(rejected) = outcome.rejected.pop() {
                return Err(format!("Not saved: the image {}.", rejected.reason));
            }
            outcome.added.pop().ok_or_else(|| "internal error: the saved sticker was not added".to_string())
        }
        SaveTarget::Replace { sticker_id } => stickers::replace_sticker_file(conn, library_dir, sticker_id, &temp.0),
    }
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
    use crate::library::schema::{load_stickers, Format};
    use crate::limits::{STICKER_MAX_KB, STICKER_SIDE};

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
        let a = write_sticker(&mut lib.conn, lib.dir.path(), SaveTarget::Append { pack_id: pack.id }, &png).unwrap();
        let b = write_sticker(&mut lib.conn, lib.dir.path(), SaveTarget::Append { pack_id: pack.id }, &webp).unwrap();
        assert_eq!((a.position, a.file_name.as_str(), a.format), (1, "001.png", Format::Png));
        assert_eq!((b.position, b.file_name.as_str(), b.format), (2, "002.webp", Format::Webp));
        assert!(a.emoji_string.is_empty());
        // The files are exactly the encoded bytes, and decode at their size.
        assert_eq!(lib.file("cats", "001.png"), png.bytes);
        assert_eq!(lib.file("cats", "002.webp"), webp.bytes);
        let back = image::load_from_memory(&lib.file("cats", "002.webp")).unwrap();
        assert_eq!((back.width(), back.height()), (STICKER_SIDE, 9));
    }

    #[test]
    fn replace_keeps_the_slot_and_emoji_and_may_change_the_format() {
        let mut lib = Lib::new();
        let pack = create_pack(&mut lib.conn, lib.dir.path(), "Dogs", None).unwrap();
        let append = SaveTarget::Append { pack_id: pack.id };
        let first = write_sticker(&mut lib.conn, lib.dir.path(), append, &encoded(&sticker_image(4), SaveFormat::Png)).unwrap();
        write_sticker(&mut lib.conn, lib.dir.path(), append, &encoded(&sticker_image(5), SaveFormat::Png)).unwrap();
        stickers::set_emoji_string(&lib.conn, first.id, "🐶").unwrap();
        let new = encoded(&sticker_image(6), SaveFormat::Webp);
        let replaced =
            write_sticker(&mut lib.conn, lib.dir.path(), SaveTarget::Replace { sticker_id: first.id }, &new).unwrap();
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
        let err = write_sticker(&mut lib.conn, lib.dir.path(), SaveTarget::Append { pack_id: pack.id }, &small).unwrap_err();
        assert!(err.starts_with("Not saved:"), "{err}");
        assert!(load_stickers(&lib.conn, pack.id).unwrap().is_empty());
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
    fn request_and_outcome_json_match_the_typescript_names() {
        let meta: SaveMeta = serde_json::from_str(&format!(
            r#"{{"width":{STICKER_SIDE},"height":3,"layers":[],"format":"webp","target":{{"kind":"replace","stickerId":7}}}}"#,
        ))
        .unwrap();
        assert_eq!((meta.doc.width, meta.doc.height, meta.format), (STICKER_SIDE, 3, SaveFormat::Webp));
        assert_eq!(meta.target, SaveTarget::Replace { sticker_id: 7 });
        let append: SaveTarget = serde_json::from_str(r#"{"kind":"append","packId":3}"#).unwrap();
        assert_eq!(append, SaveTarget::Append { pack_id: 3 });
        let too_large = SaveOutcome::TooLarge { format: SaveFormat::Png, bytes: 9, max_kilobytes: STICKER_MAX_KB };
        assert_eq!(
            serde_json::to_value(&too_large).unwrap(),
            serde_json::json!({"kind":"tooLarge","format":"png","bytes":9,"maxKilobytes":STICKER_MAX_KB})
        );
    }
}

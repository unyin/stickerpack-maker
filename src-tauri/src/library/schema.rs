//! Domain row types and SQL loaders (SPEC §3).
//!
//! Missing is DERIVED from file presence (desync.rs), never stored here.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

/// Draft (not yet on Telegram) or Live (exists on Telegram). SPEC §3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackStatus {
    Draft,
    Live,
}

impl PackStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            PackStatus::Draft => "draft",
            PackStatus::Live => "live",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "draft" => Ok(PackStatus::Draft),
            "live" => Ok(PackStatus::Live),
            other => Err(format!("unknown pack status {other:?}")),
        }
    }
}

/// Sticker image format; static packs may mix PNG and WEBP (SPEC §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Png,
    Webp,
}

impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Webp => "webp",
        }
    }

    /// Format from a file extension, case-insensitive. Only PNG/WEBP are
    /// valid sticker/thumbnail formats (SPEC §7).
    pub fn from_extension(ext: &str) -> Result<Self, String> {
        match ext.to_ascii_lowercase().as_str() {
            "png" => Ok(Format::Png),
            "webp" => Ok(Format::Webp),
            other => Err(format!("unsupported format {other:?}: expected png or webp")),
        }
    }
}

/// A Pack row. The pack's folder inside the Library is named after its
/// Short Name (`packs::pack_dir`). `thumbnail` is the unnumbered thumbnail
/// file name, or None (ADR-0003). `folder_rename_from` holds the old folder
/// name while a Short Name edit's folder rename is still pending on disk
/// (`packs::settle_pack_folder` completes it).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub id: i64,
    pub title: String,
    pub short_name: String,
    pub status: PackStatus,
    pub thumbnail: Option<String>,
    pub folder_rename_from: Option<String>,
}

/// A Sticker row. `position` is 1-based and contiguous within the pack
/// (ADR-0003); `file_name` is the order-encoded name, e.g. `001.png`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sticker {
    pub id: i64,
    pub pack_id: i64,
    pub position: i64,
    pub file_name: String,
    pub format: Format,
    pub emoji_string: String,
}

fn pack_from_row(row: &Row<'_>) -> rusqlite::Result<Pack> {
    let status: String = row.get("status")?;
    Ok(Pack {
        id: row.get("id")?,
        title: row.get("title")?,
        short_name: row.get("short_name")?,
        status: PackStatus::parse(&status).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
        })?,
        thumbnail: row.get("thumbnail")?,
        folder_rename_from: row.get("folder_rename_from")?,
    })
}

fn sticker_from_row(row: &Row<'_>) -> rusqlite::Result<Sticker> {
    let format: String = row.get("format")?;
    Ok(Sticker {
        id: row.get("id")?,
        pack_id: row.get("pack_id")?,
        position: row.get("position")?,
        file_name: row.get("file_name")?,
        format: Format::from_extension(&format).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
        })?,
        emoji_string: row.get("emoji_string")?,
    })
}

/// Load one pack by id; error when absent.
pub fn load_pack(conn: &Connection, pack_id: i64) -> Result<Pack, String> {
    conn.query_row("SELECT * FROM packs WHERE id = ?1", params![pack_id], pack_from_row)
        .optional()
        .map_err(|e| format!("cannot read pack {pack_id}: {e}"))?
        .ok_or_else(|| format!("pack {pack_id} does not exist"))
}

/// All packs, ordered by id (creation order).
pub fn load_packs(conn: &Connection) -> Result<Vec<Pack>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM packs ORDER BY id")
        .map_err(|e| format!("cannot query packs: {e}"))?;
    let rows = stmt
        .query_map([], pack_from_row)
        .map_err(|e| format!("cannot query packs: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("cannot read packs: {e}"))
}

/// One sticker by id; error when absent.
pub fn load_sticker(conn: &Connection, sticker_id: i64) -> Result<Sticker, String> {
    conn.query_row(
        "SELECT * FROM stickers WHERE id = ?1",
        params![sticker_id],
        sticker_from_row,
    )
    .optional()
    .map_err(|e| format!("cannot read sticker {sticker_id}: {e}"))?
    .ok_or_else(|| format!("sticker {sticker_id} does not exist"))
}

/// A pack's stickers in position order (1..N contiguous, ADR-0003).
pub fn load_stickers(conn: &Connection, pack_id: i64) -> Result<Vec<Sticker>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM stickers WHERE pack_id = ?1 ORDER BY position")
        .map_err(|e| format!("cannot query stickers: {e}"))?;
    let rows = stmt
        .query_map(params![pack_id], sticker_from_row)
        .map_err(|e| format!("cannot query stickers: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("cannot read stickers of pack {pack_id}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

    fn migrated() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        db::migrate(&mut conn).unwrap();
        conn.execute_batch(
            "INSERT INTO packs (id, title, short_name, status, thumbnail)
                 VALUES (1, 'My Pack', 'my_pack', 'live', 'thumbnail.png');
             INSERT INTO stickers (id, pack_id, position, file_name, format, emoji_string)
                 VALUES (10, 1, 2, '002.webp', 'webp', '🎉'),
                        (11, 1, 1, '001.png', 'png', '');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn pack_row_roundtrips() {
        let conn = migrated();
        let pack = load_pack(&conn, 1).unwrap();
        assert_eq!(pack.id, 1);
        assert_eq!(pack.title, "My Pack");
        assert_eq!(pack.short_name, "my_pack");
        assert_eq!(pack.status, PackStatus::Live);
        assert_eq!(pack.folder_rename_from, None);
        assert_eq!(pack.thumbnail.as_deref(), Some("thumbnail.png"));
    }

    #[test]
    fn stickers_load_in_position_order() {
        let conn = migrated();
        let stickers = load_stickers(&conn, 1).unwrap();
        assert_eq!(stickers.len(), 2);
        assert_eq!(stickers[0].id, 11);
        assert_eq!(stickers[0].position, 1);
        assert_eq!(stickers[0].file_name, "001.png");
        assert_eq!(stickers[0].format, Format::Png);
        assert_eq!(stickers[0].emoji_string, "");
        assert_eq!(stickers[1].id, 10);
        assert_eq!(stickers[1].format, Format::Webp);
        assert_eq!(stickers[1].emoji_string, "🎉");
    }

    #[test]
    fn load_pack_missing_id_is_an_error() {
        let conn = migrated();
        assert!(load_pack(&conn, 999).is_err());
        assert!(load_sticker(&conn, 999).is_err());
    }

    #[test]
    fn status_and_format_vocabulary() {
        assert_eq!(PackStatus::Draft.as_str(), "draft");
        assert_eq!(PackStatus::Live.as_str(), "live");
        assert_eq!(PackStatus::parse("draft").unwrap(), PackStatus::Draft);
        assert!(PackStatus::parse("published").is_err());
        assert_eq!(Format::Png.as_str(), "png");
        assert_eq!(Format::Webp.as_str(), "webp");
        assert_eq!(Format::from_extension("PNG").unwrap(), Format::Png);
        assert_eq!(Format::from_extension("webp").unwrap(), Format::Webp);
        assert!(Format::from_extension("gif").is_err());
    }

    #[test]
    fn rows_serialize_camel_case_for_the_webview() {
        let conn = migrated();
        let pack = serde_json::to_value(load_pack(&conn, 1).unwrap()).unwrap();
        assert_eq!(pack["shortName"], "my_pack");
        assert_eq!(pack["status"], "live");
        assert!(pack.get("short_name").is_none());
        let sticker = serde_json::to_value(load_sticker(&conn, 10).unwrap()).unwrap();
        assert_eq!(sticker["packId"], 1);
        assert_eq!(sticker["fileName"], "002.webp");
        assert_eq!(sticker["emojiString"], "🎉");
        assert_eq!(sticker["format"], "webp");
    }
}
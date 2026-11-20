-- 0001_init: minimal Library bootstrap (SPM-1).
-- The runner (src-tauri/src/db.rs) creates schema_migrations itself;
-- this migration only adds the meta key/value table.
-- Domain tables (packs, stickers, thumbnails, emoji, status) arrive with SPM-2.

CREATE TABLE meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

INSERT INTO meta (key, value) VALUES ('schema_kind', 'stickerpack-library');
INSERT INTO meta (key, value) VALUES ('created_at', datetime('now'));
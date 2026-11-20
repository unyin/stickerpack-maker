-- 0002_domain: Library domain schema (SPM-2, SPEC §3).
-- Missing is DERIVED from file presence (desync detection), never stored.
-- Positions are 1..N contiguous after every operation (ADR-0003).
-- NOTE: SQLite cannot defer composite (table-level) UNIQUE constraints, so
-- the rename engine renumbers by first vacating positions/file names into a
-- temp range inside the transaction, then assigning finals (ADR-0004).
-- rename_journal holds the in-flight rename plan for crash-safe
-- roll-forward recovery (ADR-0004).

CREATE TABLE packs (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    short_name TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live')),
    folder     TEXT NOT NULL,
    thumbnail  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE stickers (
    id           INTEGER PRIMARY KEY,
    pack_id      INTEGER NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL CHECK (position >= 1),
    file_name    TEXT NOT NULL,
    format       TEXT NOT NULL CHECK (format IN ('png', 'webp')),
    emoji_string TEXT NOT NULL DEFAULT '',
    UNIQUE (pack_id, position),
    UNIQUE (pack_id, file_name)
);

CREATE TABLE rename_journal (
    pack_id INTEGER PRIMARY KEY REFERENCES packs(id) ON DELETE CASCADE,
    plan    TEXT NOT NULL,
    -- 0 = phase 1 (vacate) not yet confirmed complete, 1 = phase 1 done.
    -- Recovery only re-vacates sources at phase 0: once phase 2 places
    -- files, an original name may legitimately be occupied again (ADR-0004).
    phase   INTEGER NOT NULL DEFAULT 0 CHECK (phase IN (0, 1))
);
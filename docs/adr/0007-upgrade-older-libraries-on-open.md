# Upgrade an older Library's database when the app opens it

A Library's database schema grows with the app: migration 0001 (SPM-1) created only the bootstrap tables, and migration 0002 (SPM-2) added packs, stickers and the rename journal. The app applied migrations only when it *created* a Library. Opening an existing one only checked the bootstrap schema, so a Library made by an older build passed as valid and then failed on its first query ("no such table: stickers", found in SPM-3's Windows check, 2026-11-21). SPEC §3 also said "No auto-migration in v1", which would have locked every existing Library out of each release that adds a table.

(ADR-0006 is reserved for background removal, SPM-7, so this decision takes the next free number.)

## Decision

**Opening a Library brings its database up to the current schema first** (owner decision 2026-11-21).

- `library::open` validates the Library as before (the folder, `library.db`, and the bootstrap schema with `schema_kind`), then applies every embedded migration the database lacks, in order, in **one transaction**. A failure rolls the whole upgrade back and the open fails with the migration's error; the database is left as it was.
- `db::is_current` checks first (`MAX(schema_migrations.version)` against the number of embedded migrations), so a database that is already current is never written to. Versions are only ever inserted by the migration runner, in order, so a database has no gaps.
- **Migrations are forward-only and additive.** A shipped migration is never edited; schema changes come as new numbered migrations. A database from a *newer* build (more migrations than this build knows) is left alone.
- Unchanged by this decision: re-pointing still expects an intact Library with its database (SPEC §3), and rebuilding a database from loose image files stays out of scope (SPEC §8).

## Rejected alternatives

- **No upgrades (the earlier SPEC §3 line).** Every release that adds a table would strand existing Libraries: the user's only way forward would be a fresh Library and moving every sticker by hand.
- **Refuse older Libraries with a clear message** ("made by an older version, create a fresh one"). Better than a raw SQL error, but the same dead end for the user. It was proposed during the diagnosis; the owner chose the upgrade.
- **Upgrade only after asking.** There is nothing for the user to decide: the upgrade is additive, and declining it leaves an unusable Library.

## Consequences

- **An upgraded Library cannot be opened by an older build** that predates the new tables. Downgrading the app is not supported once a newer build has opened the Library.
- Every migration must be safe to run on a Library that has real data (no destructive rewrites without their own decision), because users' Libraries upgrade silently.
- The upgrade happens on the first command that opens the Library after an update, inside the Library lock, so no other operation sees a half-upgraded schema.
- Regression test: `open_upgrades_an_older_library_to_the_current_schema` (src-tauri/src/library/mod.rs) builds a bootstrap-only Library, opens it, then lists and creates packs.

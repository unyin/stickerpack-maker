// Verifies the SQL migration files themselves against a real SQLite engine
// (bun:sqlite). The Rust runner in src-tauri/src/db.rs mirrors this logic;
// running the Rust side requires cargo (see SPM-1 blocker).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(import.meta.dir, "..", "src-tauri", "migrations");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** Mirrors src-tauri/src/db.rs::migrate (schema_migrations + ordered SQL). */
function applyAll(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  files.forEach((file, i) => {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    db.run("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [
      i + 1,
      file.replace(/\.sql$/, ""),
    ]);
  });
}

test("migration files exist and start with the bootstrap migration", () => {
  expect(files.length).toBeGreaterThan(0);
  expect(files[0]).toBe("0001_init.sql");
});

test("bootstrap migrations apply cleanly and create the meta table", () => {
  const db = new Database(":memory:");
  applyAll(db);
  const kind = db
    .query("SELECT value FROM meta WHERE key = 'schema_kind'")
    .get() as { value: string };
  expect(kind.value).toBe("stickerpack-library");
  const count = db
    .query("SELECT COUNT(*) AS n FROM schema_migrations")
    .get() as { n: number };
  expect(count.n).toBe(files.length);
  db.close();
});

test("domain migration creates the Library schema (SPM-2)", () => {
  const db = new Database(":memory:");
  applyAll(db);
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  expect(tables.map((t) => t.name)).toEqual([
    "meta",
    "packs",
    "rename_journal",
    "schema_migrations",
    "stickers",
  ]);
  // Short Names name the pack folders: unique, case-insensitively.
  db.run("INSERT INTO packs (title, short_name) VALUES ('Cats', 'cats')");
  expect(() =>
    db.run("INSERT INTO packs (title, short_name) VALUES ('Cats', 'CATS')"),
  ).toThrow();
  db.close();
});

// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
// Command names and camelCase field names must stay in sync with the Rust
// side (serde rename_all = "camelCase").
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type LibraryStatus = "unconfigured" | "ready" | "invalid";

/**
 * Library marker file name. Must stay in sync with DB_FILE_NAME in
 * src-tauri/src/library.rs — the Rust core looks for exactly this name.
 */
export const LIBRARY_DB_FILE_NAME = "library.db";

export interface AppState {
  libraryPath: string | null;
  libraryStatus: LibraryStatus;
  libraryError: string | null;
}

export function getAppState(): Promise<AppState> {
  return invoke<AppState>("get_app_state");
}

/** Suggested first-run default: Documents\Stickerpack Library. */
export function getDefaultLibraryPath(): Promise<string> {
  return invoke<string>("default_library_path");
}

/** Create a fresh Library in a new or empty folder and persist its path. */
export function createLibrary(path: string): Promise<AppState> {
  return invoke<AppState>("create_library", { path });
}

/** Re-point at another intact Library (database included). */
export function repointLibrary(path: string): Promise<AppState> {
  return invoke<AppState>("repoint_library", { path });
}

/** Native folder picker. Returns null when the user cancels. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath,
    title: "Choose a Library folder",
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * File picker targeting the Library's library.db (SPM-13, option A): Windows
 * folder pickers hide files, so re-pointing selects the marker file itself.
 * Returns the selected file path, or null when the user cancels.
 */
export async function pickLibraryDb(
  defaultPath?: string,
): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    defaultPath,
    title: `Select your Library's ${LIBRARY_DB_FILE_NAME} file`,
    filters: [
      {
        name: `Stickerpack Library (${LIBRARY_DB_FILE_NAME})`,
        extensions: ["db"],
      },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

/** Index of the last path separator (Windows or POSIX), or -1 if none. */
function lastSeparatorIndex(filePath: string): number {
  return Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
}

/** Last path segment (Windows or POSIX separators). */
export function baseName(filePath: string): string {
  return filePath.slice(lastSeparatorIndex(filePath) + 1);
}

/**
 * True when the path points at the Library marker file. Exact, case-sensitive
 * name match: the Rust core looks for exactly `library.db` on every platform.
 */
export function isLibraryDbFile(filePath: string): boolean {
  return baseName(filePath) === LIBRARY_DB_FILE_NAME;
}

/** Outcome of the SPM-13 re-point selection (picked library.db file). */
export type LibraryDbSelection =
  | { kind: "cancelled" }
  | { kind: "invalid-name" }
  | { kind: "ok"; folder: string };

/** Resolve a picked file into the Library folder to re-point at. */
export function resolveLibraryDbSelection(
  file: string | null,
): LibraryDbSelection {
  if (!file) return { kind: "cancelled" };
  if (!isLibraryDbFile(file)) return { kind: "invalid-name" };
  return { kind: "ok", folder: parentFolder(file) };
}

/** Parent folder of a file path (Windows or POSIX separators). */
export function parentFolder(filePath: string): string {
  const idx = lastSeparatorIndex(filePath);
  // No separator: the file lives in the current directory (dirname semantics).
  if (idx < 0) return ".";
  const parent = filePath.slice(0, idx);
  // Drive-root file (F:\library.db) or POSIX root (/library.db): keep the root.
  if (/^[A-Za-z]:$/.test(parent)) return parent + filePath[idx];
  return parent === "" ? filePath[idx] : parent;
}
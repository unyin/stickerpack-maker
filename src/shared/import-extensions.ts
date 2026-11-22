// Extensions the Editor can import (mirrors IMPORT_EXTENSIONS in import.rs);
// shared so the Pack Manager offers "Open in editor" only for such files.
export const IMPORT_EXTENSIONS = ["jpg", "jpeg", "jfif", "png", "webp"];

/** True when the Editor can import `path`, going by its extension. */
export function editorCanImport(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMPORT_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

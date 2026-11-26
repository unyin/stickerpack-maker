/** Index of the last path separator (Windows or POSIX), or -1 if none. */
export function lastSeparatorIndex(filePath: string): number {
  return Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
}

/** Last path segment (Windows or POSIX separators). */
export function baseName(filePath: string): string {
  return filePath.slice(lastSeparatorIndex(filePath) + 1);
}

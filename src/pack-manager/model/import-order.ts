// Bulk import order (SPEC §5, owner decision 2026-11-21). Windows hands over
// dropped files in Explorer's drag order (usually the grabbed file first),
// not its view order, and the app cannot see how Explorer is sorted. So both
// drag-drop and the Add images picker import in natural filename order:
// "sticker2" before "sticker10", case ignored.
import { naturalCollator as collator } from "../../shared/natural-collator";
import { fileNameOf } from "./messages";

/** `paths` sorted by file name, naturally; ties keep the full path order. */
export function importOrder(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => collator.compare(fileNameOf(a), fileNameOf(b)) || collator.compare(a, b));
}

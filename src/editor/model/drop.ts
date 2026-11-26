// Dropping an image file on the Editor (SPM-27): the pure decisions and the
// owner-approved wording; editor.ts only wires them to the DOM.
import { baseName } from "../../api";
import { editorCanImport } from "../../shared/import-extensions";

/** What the Editor has open when the drop lands. */
export type DropSession = "none" | "sticker" | "thumbnail";

export type DropPlan =
  | { kind: "ignore" }
  | { kind: "busy" }
  | { kind: "unsupported"; name: string; more: boolean }
  | { kind: "open"; path: string; name: string; more: boolean }
  | { kind: "ask"; path: string; name: string; more: boolean; thumbnail: boolean };

/**
 * Decide what a drop does. Only the first path counts (Windows' drop order);
 * the rest are ignored, and `more` says there were any. A dialog already
 * open, or no path, ignores the drop; a busy Editor refuses it with a note.
 */
export function dropPlan(paths: readonly string[], session: DropSession, busy: boolean, dialogOpen: boolean): DropPlan {
  if (dialogOpen || paths.length === 0) return { kind: "ignore" };
  if (busy) return { kind: "busy" };
  const path = paths[0];
  const name = baseName(path);
  const more = paths.length > 1;
  if (!editorCanImport(path)) return { kind: "unsupported", name, more };
  if (session === "none") return { kind: "open", path, name, more };
  return { kind: "ask", path, name, more, thumbnail: session === "thumbnail" };
}

export const DROP_BUSY_NOTE = "Busy: try the drop again in a moment";

const TAIL = "; dropped files after the first are ignored";

export function cantOpenMessage(name: string, more: boolean): string {
  return `Can't open “${name}”: the Editor opens PNG, JPEG and WEBP files.${more ? " Dropped files after the first are ignored." : ""}`;
}
export function openedMessage(name: string, more: boolean): string {
  return `Opened “${name}”${more ? TAIL : ""}.`;
}
export function addedMessage(name: string, more: boolean): string {
  return `Added “${name}” as a layer${more ? TAIL : ""}.`;
}
export function asStickerMessage(name: string, more: boolean): string {
  return `Opened “${name}” as a sticker${more ? TAIL : ""}.`;
}
/** The note after Cancel; empty when there was nothing else dropped. */
export function cancelledIgnoredMessage(more: boolean): string {
  return more ? "Dropped files after the first were ignored." : "";
}

export const DROP_DIALOG_TITLE = "Dropped image";

export function dropDialogBody(name: string, thumbnail: boolean, packTitle: string): { text: string; muted: boolean }[] {
  const lines = [{ text: `What should happen to “${name}”?`, muted: false }];
  if (thumbnail) lines.push({ text: `Open instead starts a new sticker, not a thumbnail for “${packTitle}”.`, muted: true });
  return lines;
}

export type DropChoice = "layer" | "open" | "cancel";

/** The three buttons, action first, safe last; Cancel is primary and the default. */
export function dropDialogButtons(thumbnail: boolean): { label: string; value: DropChoice; variant: "primary" | "secondary" }[] {
  return [
    { label: "Add as layer", value: "layer", variant: "secondary" },
    { label: thumbnail ? "Open as sticker instead" : "Open instead", value: "open", variant: "secondary" },
    { label: "Cancel", value: "cancel", variant: "primary" },
  ];
}

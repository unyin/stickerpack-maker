// The Upload list dialog (SPEC §5, SPM-21; owner decisions 2026-11-25): every
// sticker in pack order with its Emoji String, to upload them through
// @Stickers, plus the thumbnail last. It is a dialog over the pack view, not a
// pack view mode, built on the app's shared dialog (src/dialog.ts), so
// dialogOpen() is true while it is open and the pack view ignores file drops.
import { icon } from "../../icons";
import { el, errorMessage } from "../../ui";
import { openDialog } from "../../dialog";
import {
  dragSticker,
  dragThumbnail,
  revealSticker,
  revealThumbnail,
  type PackView,
  type StickerView,
} from "../api";
import { thumbnailFormat } from "../model/messages";
import {
  DRAG_TITLE,
  draftNote,
  entryMissing,
  entryMissingReason,
  EXPLORER_TITLE,
  explorerLabelFor,
  THUMBNAIL_NOTE,
  uploadDialogWidth,
  uploadEntries,
  uploadSizeWarning,
  type UploadEntry,
} from "../model/upload-list";
import { bindEmojiSave, copyButton, measureEmojiGlyph } from "./emoji-field";
import { previewImage, type Previews } from "./previews";

/** What the dialog asks of the pack view. */
export interface UploadListHost {
  /** Save a sticker's Emoji String like the detail panel does; resolves with the stored string (spaces stripped), rejects with the reason. */
  saveEmoji(sticker: StickerView, emojiString: string): Promise<string>;
}

/** Pointer travel (px) before a press on a preview becomes a drag. */
const DRAG_THRESHOLD = 4;

/** Used when the emoji glyph cannot be measured (see measureEmojiGlyph): about the box's font size. */
const GLYPH_FALLBACK_RATIO = 1.25;

/** Open the Upload list; resolves when it is closed. */
export async function openUploadList(view: PackView, previews: Previews, host: UploadListHost): Promise<void> {
  const entries = uploadEntries(view);
  const error = el("p", { class: "message ul-error", role: "alert" });
  const showError = (err: unknown) => {
    error.textContent = errorMessage(err);
  };

  const list = el("ol", { class: "ul-list", "aria-label": "Stickers in pack order" });
  for (const entry of entries) list.append(entryRow(entry));

  const notes: HTMLElement[] = [];
  const draft = draftNote(view.pack.status);
  if (draft) notes.push(el("p", { class: "ul-note muted" }, draft));
  // A warning, informational: it blocks nothing (SPEC §3).
  const size = uploadSizeWarning(view.stickers.length);
  if (size) notes.push(el("p", { class: "ul-note warn", role: "status" }, size));

  const handle = openDialog("Upload list", [...notes, error, list], [{ label: "Close", value: "close", variant: "secondary" }], "close");
  handle.dialog.classList.add("ul-dialog");

  const firstOpen = list.querySelector<HTMLElement>(".ul-open:not(:disabled)");
  (firstOpen ?? handle.buttons.get("close"))?.focus({ preventScroll: true });
  list.scrollTop = 0;

  // The preferred width fits ten emoji per row at the emoji font's measured
  // width: re-fitted when fonts finish loading. The emoji-font Setting cannot
  // change while this modal is open, so opening is the only other time.
  const fit = () => fitWidth(handle.dialog, list);
  fit();
  void document.fonts.ready.then(fit);

  await handle.result;

  function entryRow(entry: UploadEntry): HTMLElement {
    const reason = entryMissingReason(entry);
    const open = el(
      "button",
      { class: "secondary ul-open", type: "button", "aria-label": explorerLabelFor(entry) },
      icon("external"),
    ) as HTMLButtonElement;
    // §2: when the control is disabled the blocker reason replaces the description.
    open.disabled = reason !== null;
    open.title = reason ?? EXPLORER_TITLE;
    open.addEventListener("click", () => {
      error.textContent = "";
      const done = entry.kind === "thumbnail" ? revealThumbnail(view.pack.id) : revealSticker(entry.sticker.id);
      done.catch(showError);
    });

    const preview = previewCell(entry, reason);
    if (entry.kind === "thumbnail") {
      return el(
        "li",
        { class: ["ul-entry", "thumb", reason ? "missing" : ""].join(" ").trim() },
        el("span", {}),
        preview,
        open,
        el("span", {}),
        el("span", { class: "ul-thumb-note" }, THUMBNAIL_NOTE),
      );
    }

    const sticker = entry.sticker;
    const input = el("textarea", {
      class: "pm-input pm-emoji-input",
      rows: "2",
      spellcheck: "false",
      "aria-label": `Emoji String for #${sticker.position}`,
    }) as HTMLTextAreaElement;
    input.value = sticker.emojiString;
    let saved = sticker.emojiString;
    bindEmojiSave(input, (value) => {
      error.textContent = "";
      host.saveEmoji(sticker, value).then(
        (stored) => {
          saved = stored;
          input.value = stored; // spaces stripped, as saved
        },
        (err) => {
          input.value = saved;
          showError(err);
        },
      );
    });
    const { button: copy, status } = copyButton(() => input.value, `Copy the Emoji String of #${sticker.position} to the clipboard`);
    return el(
      "li",
      { class: ["ul-entry", reason ? "missing" : ""].join(" ").trim() },
      el("span", { class: "pm-pos" }, `#${sticker.position}`),
      preview,
      open,
      el("span", { class: "ul-copy-cell" }, copy, status),
      el("div", { class: "ul-emoji-wrap" }, input),
    );
  }

  /** The entry's image; a drag handle unless its file is Missing. */
  function previewCell(entry: UploadEntry, reason: string | null): HTMLElement {
    const missing = entryMissing(entry);
    const art = missing
      ? el("div", { class: "pm-missing-art" }, "Missing")
      : entry.kind === "thumbnail"
        ? previewImage(previews.thumbnailOf(view.pack.id, thumbnailFormat(view.pack.thumbnail)), "Thumbnail", "pm-tile-img")
        : previewImage(previews.sticker(entry.sticker.id, entry.sticker.format), `Sticker ${entry.sticker.position}`, "pm-tile-img");
    const cell = el("span", { class: missing ? "ul-prev" : "ul-prev draggable" }, art);
    cell.title = reason ?? DRAG_TITLE;
    if (!missing) {
      makeDragHandle(cell, () => {
        error.textContent = "";
        const done = entry.kind === "thumbnail" ? dragThumbnail(view.pack.id) : dragSticker(entry.sticker.id);
        return done.catch(showError);
      });
    }
    return cell;
  }
}

/**
 * Press and move on `cell` starts a native file drag (`start`), once the
 * pointer has travelled DRAG_THRESHOLD px, so a plain click does nothing. The
 * webview's own HTML5 drag of the image is suppressed: the OS drag replaces it.
 */
function makeDragHandle(cell: HTMLElement, start: () => Promise<unknown>): void {
  let press: { id: number; x: number; y: number } | null = null;
  const release = () => {
    if (press && cell.hasPointerCapture(press.id)) cell.releasePointerCapture(press.id);
    press = null;
  };
  cell.addEventListener("dragstart", (e) => e.preventDefault());
  cell.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    cell.setPointerCapture(e.pointerId); // moves keep arriving if the pointer outruns the 56px box
  });
  cell.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.id) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD) return;
    release();
    void start();
  });
  cell.addEventListener("pointerup", release);
  cell.addEventListener("pointercancel", release);
}

/**
 * Set the dialog's preferred width: ten emoji per row in the first emoji box,
 * plus everything else across the dialog (padding, the fixed columns, the
 * list's scrollbar), measured from the live layout. CSS caps it at the
 * viewport (`.ul-dialog`), and the emoji column shrinks instead.
 */
function fitWidth(dialog: HTMLElement, list: HTMLElement): void {
  const box = list.querySelector<HTMLTextAreaElement>("textarea");
  if (!box?.isConnected) return;
  const cs = getComputedStyle(box);
  const glyph = measureEmojiGlyph(cs.fontSize, cs.fontFamily) ?? parseFloat(cs.fontSize) * GLYPH_FALLBACK_RATIO;
  // The box's own chrome: padding, border and the reserved scrollbar gutter.
  const gutter = Math.max(0, box.offsetWidth - box.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth));
  const boxChrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) + gutter;
  const contentNow = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const dialogChrome = dialog.getBoundingClientRect().width - contentNow - boxChrome;
  dialog.style.setProperty("--ul-w", `${Math.ceil(uploadDialogWidth(glyph, boxChrome, dialogChrome))}px`);
}

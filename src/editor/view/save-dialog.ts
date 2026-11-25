// The Editor's save dialogs (SPEC §6 Save, SPM-10/12): where the image goes
// and the format, PNG or WEBP, per save. A session opened with the Pack
// Manager's Edit offers, at the top, to replace that sticker (the default)
// or to save as a new sticker; a session from an image file only saves new
// stickers, into the pack chosen in the pack picker (owner decisions
// 2026-11-22); a Thumbnail mode session (SPM-12) saves the pack's
// thumbnail, the pack itself already chosen. Saving itself runs in
// `submit`, so a refusal can stay in the dialog. The pack picker is the
// Pack Manager's: its styles come with it.
import "../../pack-manager/pack-manager.css";
import "../editor.css";
import { openDialog, type DialogHandle } from "../../dialog";
import { el, errorMessage } from "../../ui";
import { packPicker } from "../../pack-manager/view/dialogs";
import { loadPackView, type PackSummary } from "../../pack-manager/api";
import { initialFocus } from "../../pack-manager/model/pack-memory";
import type { ConstraintSet } from "../model/constraints";
import { FORMAT_LABEL, replaceLabel, resolveOrigin, type OriginLookup, type OriginNow, type SaveFormat } from "../save";
import type { StickerOrigin } from "../../shared/sticker-origin";
import type { ThumbnailOrigin } from "../../shared/thumbnail-origin";

/**
 * The PNG/WEBP toggle row, shared by the sticker and thumbnail save dialogs:
 * one radio group plus its readers, set to `initial`. The pair renders as a
 * segmented control (SPEC §6 Save, owner 2026-11-25) — one rectangle split
 * into two tinted halves — while the radios underneath stay the real control,
 * so arrow keys, tab order and the screen-reader semantics are unchanged.
 */
function formatRow(initial: SaveFormat): {
  row: HTMLElement;
  format(): SaveFormat;
  setFormat(format: SaveFormat): void;
} {
  const radios = new Map<SaveFormat, HTMLInputElement>();
  const row = el("div", { class: "editor-save-format", role: "radiogroup", "aria-label": "Format" });
  for (const format of ["png", "webp"] as const) {
    // Visually hidden but focusable: sr-only keeps the radio in the tab order
    // and in the group; its label paints the state.
    const radio = el("input", {
      type: "radio",
      name: "save-format",
      value: format,
      class: "sr-only",
    }) as HTMLInputElement;
    radios.set(format, radio);
    row.append(el("label", { class: "editor-format-half" }, radio, FORMAT_LABEL[format]));
  }
  const setFormat = (format: SaveFormat) => {
    for (const [value, radio] of radios) radio.checked = value === format;
  };
  setFormat(initial);
  return { row, format: () => (radios.get("webp")!.checked ? "webp" : "png"), setFormat };
}

/** Where the save goes: over the origin sticker, or a new sticker in a pack. */
export type SaveChoice = { readonly format: SaveFormat } & (
  | { readonly kind: "replace"; readonly origin: StickerOrigin; readonly now: OriginNow }
  | { readonly kind: "new"; readonly pack: PackSummary }
);

export interface SaveDialogOptions {
  readonly constraints: ConstraintSet;
  /** The format to start on when there is no origin sticker to take it from. */
  readonly format: SaveFormat;
  /** The sticker this session edits (opened with Edit), or null. */
  readonly origin: StickerOrigin | null;
  /**
   * The Emoji String a new sticker would carry (the Emoji tab's value,
   * SPM-15); "" shows the without-emoji hint. The view pass (D3) restyles
   * this dialog; the hint's condition is data, not layout.
   */
  readonly emojiString: string;
  /**
   * Save with the choice. Resolve null to close the dialog, or a line to
   * show in it while it stays open (e.g. "Not saved: …"). A rejection shows
   * its message and the dialog stays open too.
   */
  submit(choice: SaveChoice, setFormat: (format: SaveFormat) => void): Promise<string | null>;
}

/**
 * Where the origin sticker is now, or why it cannot be replaced: the ONE
 * lookup both the save dialog (Replace gone, SPEC §6) and the Editor's
 * clean-close warning (owner decision 2026-11-23) ask, so the two can
 * never disagree.
 */
export async function originNow(origin: StickerOrigin): Promise<OriginLookup> {
  // Never look an old Library's pack id up in the new one.
  if (origin.otherLibrary) return resolveOrigin(origin, null);
  try {
    return resolveOrigin(origin, await loadPackView(origin.packId));
  } catch {
    return resolveOrigin(origin, null); // the pack is gone (or unreadable)
  }
}

/** Open the save dialog; resolves when it closes (what happened is `submit`'s to report). */
export async function saveDialog(options: SaveDialogOptions): Promise<void> {
  const { origin } = options;
  const message = el("div", { class: "message", role: "alert" });
  let handle: DialogHandle<"save" | "cancel"> | null = null;
  const picker = packPicker({ message, onChange: () => sync() });

  // Replace or new (only with an origin sticker).
  let now: OriginNow | null = null;
  const replaceRadio = el("input", { type: "radio", name: "save-target", value: "replace" }) as HTMLInputElement;
  const newRadio = el("input", { type: "radio", name: "save-target", value: "new" }) as HTMLInputElement;
  const replaceText = el("span", {}, origin ? replaceLabel({ ...origin, format: options.format }) : "");
  const replaceOption = el("label", { class: "pm-check" }, replaceRadio, " ", replaceText);
  const targetRow = el(
    "div",
    { class: "editor-save-target", role: "radiogroup", "aria-label": "Save as" },
    replaceOption,
    el("label", { class: "pm-check" }, newRadio, " Save as a new sticker"),
  );
  replaceRadio.checked = origin !== null;
  newRadio.checked = origin === null;
  const replacing = () => origin !== null && replaceRadio.checked;
  const emojiHint = options.emojiString === "" ? "without emoji" : "with its emoji";
  const packSection = el(
    "div",
    { class: "editor-save-pack" },
    el("p", { class: "field-label" }, "Pack"),
    ...picker.elements,
    el("p", { class: "muted pm-hint" }, `The sticker goes to the end of the pack, ${emojiHint}.`),
  );

  const { row: formatToggle, format, setFormat } = formatRow(options.format);
  const limit = `${options.constraints.maxKilobytes} KB`;

  function sync(): void {
    packSection.hidden = replacing();
    const save = handle?.buttons.get("save");
    if (!save) return;
    const why = replacing()
      ? now === null
        ? "Checking the sticker…"
        : null
      : picker.selected() === null
        ? "Choose a pack to save into"
        : null;
    save.disabled = why !== null;
    save.title = why ?? "";
  }
  for (const radio of [replaceRadio, newRadio]) radio.addEventListener("change", () => sync());

  const save = async (): Promise<boolean> => {
    let choice: SaveChoice;
    if (replacing() && origin && now) choice = { kind: "replace", origin, now, format: format() };
    else {
      const pack = picker.selected();
      if (replacing() || !pack) return false;
      choice = { kind: "new", pack, format: format() };
    }
    message.textContent = "";
    try {
      const stay = await options.submit(choice, setFormat);
      if (stay !== null) {
        message.textContent = stay;
        return false;
      }
      return true;
    } catch (err) {
      message.textContent = errorMessage(err);
      return false;
    }
  };

  handle = openDialog<"save" | "cancel">(
    "Save sticker",
    [
      ...(origin ? [targetRow] : []),
      packSection,
      el("p", { class: "field-label" }, "Format"),
      formatToggle,
      el(
        "p",
        { class: "muted pm-hint" },
        `PNG keeps every pixel. WEBP is smaller: it keeps every pixel when that fits in ${limit}, and otherwise lowers the quality only as far as the limit needs.`,
      ),
      message,
    ],
    [
      { label: "Save", value: "save", variant: "primary", action: save },
      { label: "Cancel", value: "cancel" },
    ],
    "cancel",
  );
  sync();
  const [found] = await Promise.all([origin ? originNow(origin) : Promise.resolve(null), picker.load()]);
  if (found && "gone" in found) {
    // Never write to another slot: only a new sticker is left (owner decision 2026-11-22).
    replaceRadio.disabled = true;
    replaceOption.title = found.gone; // disabled controls show their reason (SPEC §2)
    replaceRadio.checked = false;
    newRadio.checked = true;
    message.textContent = found.gone;
  } else if (found) {
    now = found;
    replaceText.textContent = replaceLabel(found);
    // A replace keeps the sticker's format unless changed here (not overriding a pick made meanwhile).
    if (format() === options.format) setFormat(found.format);
  }
  sync();
  if (replacing() || initialFocus("save", picker.selected() !== null) === "submit") handle.buttons.get("save")?.focus();
  else picker.focus();
  await handle.result;
}

export interface ThumbnailSaveOptions {
  readonly constraints: ConstraintSet; // THUMBNAIL
  readonly format: SaveFormat;
  /** The pack whose thumbnail this session saves into. */
  readonly origin: ThumbnailOrigin;
  submit(choice: { readonly format: SaveFormat }, setFormat: (format: SaveFormat) => void): Promise<string | null>;
}

/**
 * Open the thumbnail save dialog (SPM-12): the pack is already chosen (the
 * session's origin), so it shows the pack's current title and only the
 * format is picked. Saving runs in `submit` like the sticker dialog's, so a
 * refusal stays in the dialog.
 */
export async function thumbnailSaveDialog(options: ThumbnailSaveOptions): Promise<void> {
  const { origin } = options;
  const message = el("div", { class: "message", role: "alert" });
  // The pack's title as the session took it, replaced by the current one
  // once the open lookup answers (like the sticker dialog's Replace label).
  const title = el("span", {}, `“${origin.packTitle}”`);
  const packSection = el(
    "div",
    { class: "editor-save-pack" },
    el("p", { class: "field-label" }, "Pack"),
    el("p", {}, title),
  );
  const { row, format, setFormat } = formatRow(options.format);
  const limit = `${options.constraints.maxKilobytes} KB`;
  let handle: DialogHandle<"save" | "cancel"> | null = null;
  /** Why Save is disabled (SPEC §2: the reason shows in its tooltip), or null. */
  let blocked: string | null = origin.otherLibrary
    ? "The pack belongs to the Library used before, so the thumbnail cannot be saved."
    : null;
  if (blocked) message.textContent = blocked;
  const sync = (): void => {
    const save = handle?.buttons.get("save");
    if (!save) return;
    save.disabled = blocked !== null;
    save.title = blocked ?? "";
  };

  const save = async (): Promise<boolean> => {
    message.textContent = "";
    try {
      const stay = await options.submit({ format: format() }, setFormat);
      if (stay !== null) {
        message.textContent = stay;
        return false;
      }
      return true;
    } catch (err) {
      message.textContent = errorMessage(err);
      return false;
    }
  };

  handle = openDialog<"save" | "cancel">(
    "Save thumbnail",
    [
      packSection,
      el("p", { class: "field-label" }, "Format"),
      row,
      el(
        "p",
        { class: "muted pm-hint" },
        `PNG keeps every pixel. WEBP is smaller: it keeps every pixel when that fits in ${limit}, and otherwise lowers the quality only as far as the limit needs.`,
      ),
      message,
    ],
    [
      { label: "Save", value: "save", variant: "primary", action: save },
      { label: "Cancel", value: "cancel" },
    ],
    "cancel",
  );
  sync();
  // Look the pack up (never an old Library's id), showing its current title.
  if (!origin.otherLibrary) {
    try {
      const view = await loadPackView(origin.packId);
      title.textContent = `“${view.pack.title}”`;
      // The pack is inherently chosen: Save starts focused, like the sticker
      // dialog with a pack pre-chosen, so Enter saves at once.
      handle.buttons.get("save")?.focus();
    } catch {
      blocked = `The pack “${origin.packTitle}” no longer exists, so the thumbnail cannot be saved.`;
      message.textContent = blocked;
      sync();
    }
  }
  await handle.result;
}

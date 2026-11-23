// The Editor's save dialog (SPEC §6 Save, SPM-10): where the image goes and
// the format, PNG or WEBP, per save. A session opened with the Pack
// Manager's Edit offers, at the top, to replace that sticker (the default)
// or to save as a new sticker; a session from an image file only saves new
// stickers, into the pack chosen in the pack picker (owner decisions
// 2026-11-22). Saving itself runs in `submit`, so a refusal can stay in the
// dialog. The pack picker is the Pack Manager's: its styles come with it.
import "../../pack-manager/pack-manager.css";
import "../editor.css";
import { openDialog, type DialogHandle } from "../../dialog";
import { el, errorMessage } from "../../ui";
import { packPicker } from "../../pack-manager/view/dialogs";
import { loadPackView, type PackSummary } from "../../pack-manager/api";
import { initialFocus } from "../../pack-manager/model/pack-memory";
import type { ConstraintSet } from "../model/constraints";
import { FORMAT_LABEL, replaceLabel, resolveOrigin, type OriginNow, type SaveFormat } from "../save";
import type { StickerOrigin } from "../../shared/sticker-origin";

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
   * Save with the choice. Resolve null to close the dialog, or a line to
   * show in it while it stays open (e.g. "Not saved: …"). A rejection shows
   * its message and the dialog stays open too.
   */
  submit(choice: SaveChoice, setFormat: (format: SaveFormat) => void): Promise<string | null>;
}

/** Where the origin sticker is now, or why it cannot be replaced. */
async function originNow(origin: StickerOrigin): Promise<OriginNow | { readonly gone: string }> {
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
  const packSection = el(
    "div",
    { class: "editor-save-pack" },
    el("p", { class: "field-label" }, "Pack"),
    ...picker.elements,
    el("p", { class: "muted pm-hint" }, "The sticker goes to the end of the pack, without emoji."),
  );

  const radios = new Map<SaveFormat, HTMLInputElement>();
  const formatRow = el("div", { class: "editor-save-format", role: "radiogroup", "aria-label": "Format" });
  for (const format of ["png", "webp"] as const) {
    const radio = el("input", { type: "radio", name: "save-format", value: format }) as HTMLInputElement;
    radios.set(format, radio);
    formatRow.append(el("label", { class: "pm-check" }, radio, ` ${FORMAT_LABEL[format]}`));
  }
  const format = (): SaveFormat => (radios.get("webp")!.checked ? "webp" : "png");
  const setFormat = (f: SaveFormat) => {
    for (const [value, radio] of radios) radio.checked = value === f;
  };
  setFormat(options.format);
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
      formatRow,
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

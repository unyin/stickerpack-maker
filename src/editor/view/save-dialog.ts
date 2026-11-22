// The Editor's save dialog (SPEC §6 Save, SPM-10): pick the target pack
// (searchable, with inline New pack) and the format, PNG or WEBP, per save.
// Saving itself runs in `submit`, so a refusal can stay in the dialog.
// The pack picker is the Pack Manager's: its styles come with it.
import "../../pack-manager/pack-manager.css";
import "../editor.css";
import { openDialog, type DialogHandle } from "../../dialog";
import { el, errorMessage } from "../../ui";
import { packPicker } from "../../pack-manager/view/dialogs";
import type { PackSummary } from "../../pack-manager/api";
import { initialFocus } from "../../pack-manager/model/pack-memory";
import type { ConstraintSet } from "../model/constraints";
import { FORMAT_LABEL, type SaveFormat } from "../save";

export interface SaveChoice {
  readonly pack: PackSummary;
  readonly format: SaveFormat;
}

export interface SaveDialogOptions {
  readonly constraints: ConstraintSet;
  readonly format: SaveFormat;
  /**
   * Save with the choice. Resolve null to close the dialog, or a line to
   * show in it while it stays open (e.g. "Not saved: …"). A rejection shows
   * its message and the dialog stays open too.
   */
  submit(choice: SaveChoice, setFormat: (format: SaveFormat) => void): Promise<string | null>;
}

/** Open the save dialog; resolves when it closes (what happened is `submit`'s to report). */
export async function saveDialog(options: SaveDialogOptions): Promise<void> {
  const message = el("div", { class: "message", role: "alert" });
  let handle: DialogHandle<"save" | "cancel"> | null = null;
  const picker = packPicker({
    message,
    onChange: () => syncSave(),
  });
  const radios = new Map<SaveFormat, HTMLInputElement>();
  const formatRow = el("div", { class: "editor-save-format", role: "radiogroup", "aria-label": "Format" });
  for (const format of ["png", "webp"] as const) {
    const radio = el("input", { type: "radio", name: "save-format", value: format }) as HTMLInputElement;
    radio.checked = format === options.format;
    radios.set(format, radio);
    formatRow.append(el("label", { class: "pm-check" }, radio, ` ${FORMAT_LABEL[format]}`));
  }
  const format = (): SaveFormat => (radios.get("webp")!.checked ? "webp" : "png");
  const setFormat = (f: SaveFormat) => {
    for (const [value, radio] of radios) radio.checked = value === f;
  };
  const limit = `${options.constraints.maxKilobytes} KB`;

  function syncSave(): void {
    const save = handle?.buttons.get("save");
    if (!save) return;
    save.disabled = picker.selected() === null;
    save.title = picker.selected() === null ? "Choose a pack to save into" : "";
  }

  const save = async (): Promise<boolean> => {
    const pack = picker.selected();
    if (!pack) return false;
    const choice = { pack, format: format() };
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
      el("p", { class: "field-label" }, "Pack"),
      ...picker.elements,
      el("p", { class: "muted pm-hint" }, "The sticker goes to the end of the pack, without emoji."),
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
  syncSave();
  await picker.load();
  if (initialFocus("save", picker.selected() !== null) === "submit") handle.buttons.get("save")?.focus();
  else picker.focus();
  await handle.result;
}

// The text tool's font picker (SPM-9, owner decision 2026-11-22): the app's
// combobox (src/combobox.ts) over the installed font families, each name
// shown in its own typeface, with type-to-search (matchFonts). The field
// shows the chosen font in its face. A pick gives up focus, so the Editor's
// shortcuts work at once.
import { Combobox } from "../../combobox";
import { cssFontFamily, matchFonts } from "./geometry";

const faceOf = (family: string) => `${cssFontFamily(family)}, var(--font-ui)`;

export class FontPicker {
  private readonly box: Combobox<string>;

  constructor(label: string) {
    this.box = new Combobox<string>({
      label,
      className: "font-picker",
      emptyText: "No font matches.",
      key: (f) => f,
      text: (f) => f,
      match: matchFonts,
      renderOption: (f, li) => {
        li.textContent = f;
        li.style.fontFamily = faceOf(f);
      },
      styleField: (input, f) => {
        input.style.fontFamily = f ? faceOf(f) : "";
      },
      releaseFocusOnPick: true,
    });
  }

  get element(): HTMLElement {
    return this.box.element;
  }

  /** Called with the picked family (only when it differs from the current one). */
  onChange(listener: (family: string) => void): void {
    this.box.onChange(listener);
  }

  /** The families to offer; the options are rebuilt only when the list changes. */
  setFonts(fonts: readonly string[]): void {
    this.box.setItems(fonts);
  }

  /** Show `family` as the current font (not while the user is picking). */
  set value(family: string) {
    this.box.value = family === "" ? null : family;
  }

  set disabled(disabled: boolean) {
    this.box.disabled = disabled;
  }

  set title(title: string) {
    this.box.title = title;
  }
}

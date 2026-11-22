// The text tool's font picker (SPM-9, owner decision 2026-11-22): an
// editable combobox (WAI-ARIA combobox pattern) whose list shows every font
// name in its own typeface, with type-to-search. The field shows the
// chosen font in its face; typing filters the list (matchFonts), the
// arrow keys move through it, Enter or a click picks, and Esc or leaving
// the field reverts. Focus stays in the INPUT while the list is open, so
// the Editor's shortcuts never act on the layers meanwhile.
import { el } from "../../ui";
import { cssFontFamily, matchFonts } from "./geometry";

let pickers = 0;

export class FontPicker {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  /** Announced (role "status") while the open list has no match; generated CSS content is not. */
  private readonly empty: HTMLElement;
  private readonly idBase = `font-picker-${++pickers}`;
  private fonts: readonly string[] = [];
  /** The options by font, built once per font list. */
  private options = new Map<string, HTMLLIElement>();
  /** The fonts the open list shows, in order, and the highlighted one. */
  private shown: readonly string[] = [];
  private active = -1;
  /** The list is open (its element is also hidden while nothing matches). */
  private opened = false;
  private current = "";
  private changed?: (family: string) => void;

  constructor(label: string) {
    this.input = el("input", {
      class: "font-picker-input",
      type: "text",
      role: "combobox",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": label,
      "aria-autocomplete": "list",
      "aria-expanded": "false",
      "aria-controls": `${this.idBase}-list`,
    }) as HTMLInputElement;
    this.list = el("ul", { class: "font-picker-list", role: "listbox", id: `${this.idBase}-list`, "aria-label": label }) as HTMLUListElement;
    this.list.hidden = true;
    this.empty = el("p", { class: "font-picker-empty", role: "status" }, "No font matches.");
    this.empty.hidden = true;
    this.element = el("div", { class: "font-picker" }, this.input, this.list, this.empty);

    this.input.addEventListener("focus", () => this.open());
    this.input.addEventListener("click", () => {
      if (!this.opened) this.open();
    });
    this.input.addEventListener("input", () => this.filter(this.input.value));
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.input.addEventListener("blur", () => this.closeList());
    // Pressing an option must not blur the input first (that would revert).
    this.list.addEventListener("mousedown", (e) => e.preventDefault());
    this.list.addEventListener("click", (e) => {
      const option = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-font]");
      if (option) this.choose(option.dataset.font!);
    });
  }

  /** Called with the picked family (only when it differs from the current one). */
  onChange(listener: (family: string) => void): void {
    this.changed = listener;
  }

  /** The families to offer; the options are rebuilt only when the list changes. */
  setFonts(fonts: readonly string[]): void {
    if (fonts.length === this.fonts.length && fonts.every((f, i) => f === this.fonts[i])) return;
    this.fonts = fonts;
    this.options = new Map(
      fonts.map((font, i) => {
        const li = el("li", { role: "option", id: `${this.idBase}-${i}`, "data-font": font }, font) as HTMLLIElement;
        li.style.fontFamily = `${cssFontFamily(font)}, var(--font-ui)`;
        return [font, li];
      }),
    );
    this.list.replaceChildren(...this.options.values());
    if (this.opened) this.filter("");
  }

  /** Show `family` as the current font (not while the user is picking). */
  set value(family: string) {
    this.current = family;
    if (!this.opened) this.showCurrent();
  }

  set disabled(disabled: boolean) {
    this.input.disabled = disabled;
    if (disabled) this.closeList();
  }

  set title(title: string) {
    this.input.title = title;
  }

  private showCurrent(): void {
    this.input.value = this.current;
    this.input.style.fontFamily = this.current ? `${cssFontFamily(this.current)}, var(--font-ui)` : "";
  }

  private open(): void {
    if (this.input.disabled) return;
    this.opened = true;
    this.input.setAttribute("aria-expanded", "true");
    this.input.style.fontFamily = ""; // typed text reads in the UI font
    this.filter("");
    this.setActive(this.shown.indexOf(this.current));
    this.input.select();
  }

  private closeList(): void {
    this.opened = false;
    this.list.hidden = true;
    this.empty.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
    this.showCurrent();
  }

  /** Show the fonts matching `query`, highlighting the first. */
  private filter(query: string): void {
    this.shown = matchFonts(this.fonts, query);
    this.list.replaceChildren(...this.shown.map((f) => this.options.get(f)!));
    this.list.hidden = this.shown.length === 0;
    this.empty.hidden = this.shown.length > 0;
    this.setActive(this.shown.length > 0 ? 0 : -1);
  }

  private setActive(index: number): void {
    this.options.get(this.shown[this.active])?.setAttribute("aria-selected", "false");
    this.active = index;
    const li = this.options.get(this.shown[index]);
    if (!li) {
      this.input.removeAttribute("aria-activedescendant");
      return;
    }
    li.setAttribute("aria-selected", "true");
    this.input.setAttribute("aria-activedescendant", li.id);
    li.scrollIntoView({ block: "nearest" });
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.opened) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        this.open();
      }
      return;
    }
    const last = this.shown.length - 1;
    if (e.key === "ArrowDown") this.setActive(Math.min(this.active + 1, last));
    else if (e.key === "ArrowUp") this.setActive(Math.max(this.active - 1, 0));
    else if (e.key === "PageDown") this.setActive(Math.min(this.active + 10, last));
    else if (e.key === "PageUp") this.setActive(Math.max(this.active - 10, 0));
    else if (e.key === "Enter") {
      const font = this.shown[this.active];
      if (font === undefined) return;
      this.choose(font);
    } else if (e.key === "Escape") this.input.blur(); // reverts, and the Editor's keys work again
    else return;
    e.preventDefault();
  }

  /** Pick `font`: close the list, give up focus (the Editor's shortcuts work at once), report a change. */
  private choose(font: string): void {
    const changed = font !== this.current;
    this.current = font;
    this.input.blur();
    if (changed) this.changed?.(font);
  }
}

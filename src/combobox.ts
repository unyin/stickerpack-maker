// The app's pick-one-of-many field (WAI-ARIA combobox pattern): the
// Editor's font picker (SPM-9) and the pack picker of Save and Send to pack
// (owner decision 2026-11-22: "font-picker style"). A closed field shows the
// current item; clicking, focusing or typing opens a list below, typing
// filters it, the arrow keys move through it, Enter or a click picks, and
// Esc or leaving the field reverts. Focus stays in the INPUT while the list
// is open, so shortcuts and dialogs never see the keys it handles.
import "./combobox.css";
import { el } from "./ui";

let comboboxes = 0;

export interface ComboboxOptions<T> {
  /** Accessible name of the field and its list. */
  readonly label: string;
  /**
   * CSS class prefix for this use, beside the shared `combobox*` classes
   * (combobox.css): `<prefix>`, `<prefix>-input`, `<prefix>-list`, `<prefix>-empty`.
   */
  readonly className: string;
  /** Announced when the typed text matches nothing. */
  readonly emptyText: string;
  /** A unique key per item. */
  key(item: T): string;
  /** The item's name: what the field shows. */
  text(item: T): string;
  /** The items matching a typed query, in the order to list them. */
  match(items: readonly T[], query: string): readonly T[];
  /** Fill an option (default: the item's name). */
  renderOption?(item: T, option: HTMLLIElement): void;
  /** Style the field for the item it shows, or null while typing or empty. */
  styleField?(input: HTMLInputElement, item: T | null): void;
  /**
   * Give up focus after a pick (the font picker: the Editor's shortcuts work
   * at once). Otherwise focus stays in the field, as a dialog wants.
   */
  readonly releaseFocusOnPick?: boolean;
  readonly placeholder?: string;
}

export class Combobox<T> {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  /** Announced (role "status") while the open list has no match; generated CSS content is not. */
  private readonly empty: HTMLElement;
  private readonly idBase: string;
  private items: readonly T[] = [];
  /** The options by key, built once per item list. */
  private options = new Map<string, HTMLLIElement>();
  /** The items the open list shows, in order, and the highlighted one. */
  private shown: readonly T[] = [];
  private active = -1;
  /** The list is open (its element is also hidden while nothing matches). */
  private opened = false;
  private current: T | null = null;
  private changed?: (item: T) => void;

  constructor(private readonly config: ComboboxOptions<T>) {
    const { label, className } = config;
    this.idBase = `${className}-${++comboboxes}`;
    this.input = el("input", {
      class: `combobox-input ${className}-input`,
      type: "text",
      role: "combobox",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": label,
      "aria-autocomplete": "list",
      "aria-expanded": "false",
      "aria-controls": `${this.idBase}-list`,
      ...(config.placeholder ? { placeholder: config.placeholder } : {}),
    }) as HTMLInputElement;
    this.list = el("ul", { class: `combobox-list ${className}-list`, role: "listbox", id: `${this.idBase}-list`, "aria-label": label }) as HTMLUListElement;
    this.list.hidden = true;
    this.empty = el("p", { class: `combobox-empty ${className}-empty`, role: "status" }, config.emptyText);
    this.empty.hidden = true;
    this.element = el("div", { class: `combobox ${className}` }, this.input, this.list, this.empty);

    this.input.addEventListener("focus", () => this.open());
    this.input.addEventListener("click", () => {
      if (!this.opened) this.open();
    });
    this.input.addEventListener("input", () => {
      if (!this.opened) this.open(false); // typing after a pick reopens the list
      this.filter(this.input.value);
    });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.input.addEventListener("blur", () => this.closeList());
    // Pressing an option must not blur the input first (that would revert).
    this.list.addEventListener("mousedown", (e) => e.preventDefault());
    // The pointer moves the one highlight, as the arrow keys do (owner, 2026-11-22).
    // mousemove, not mouseover: an option scrolled under a resting pointer by the
    // arrow keys must not take the highlight back.
    this.list.addEventListener("mousemove", (e) => {
      const index = this.indexOf((e.target as HTMLElement).closest<HTMLLIElement>("li[data-key]"));
      if (index >= 0 && index !== this.active) this.setActive(index, false);
    });
    this.list.addEventListener("click", (e) => {
      const item = this.shown[this.indexOf((e.target as HTMLElement).closest<HTMLLIElement>("li[data-key]"))];
      if (item !== undefined) this.choose(item);
    });
  }

  /** Called with the picked item (only when it differs from the current one). */
  onChange(listener: (item: T) => void): void {
    this.changed = listener;
  }

  /**
   * The items to offer. The options are rebuilt only when the keys or names
   * change, so other content an option shows (a pack's sticker count) is
   * drawn once per item list: give a fresh picker for fresh data.
   */
  setItems(items: readonly T[]): void {
    const { key, text } = this.config;
    const same =
      items.length === this.items.length &&
      items.every((item, i) => key(item) === key(this.items[i]) && text(item) === text(this.items[i]));
    this.items = items;
    if (same) return;
    this.options = new Map(
      items.map((item, i) => {
        const li = el("li", { role: "option", id: `${this.idBase}-${i}`, "data-key": key(item) }) as HTMLLIElement;
        if (this.config.renderOption) this.config.renderOption(item, li);
        else li.textContent = text(item);
        return [key(item), li];
      }),
    );
    if (this.opened) this.filter(this.input.value);
  }

  /** The current item, or null. */
  get value(): T | null {
    return this.current;
  }

  /** Show `item` as the current one (not while the user is picking). */
  set value(item: T | null) {
    this.current = item;
    if (!this.opened) this.showCurrent();
  }

  /**
   * Choose `item` for the user (a default, a pack just created): unlike
   * setting `value`, it also closes an open list, so the field shows it at
   * once. No change is reported.
   */
  select(item: T): void {
    this.current = item;
    this.closeList();
  }

  set disabled(disabled: boolean) {
    this.input.disabled = disabled;
    if (disabled) this.closeList();
  }

  set title(title: string) {
    this.input.title = title;
  }

  /** What the empty field says. */
  set placeholder(text: string) {
    this.input.placeholder = text;
  }

  focus(): void {
    this.input.focus();
  }

  private showCurrent(): void {
    this.input.value = this.current === null ? "" : this.config.text(this.current);
    this.config.styleField?.(this.input, this.current);
  }

  /** Open the list on every item, the current one highlighted; `selectText` selects the field's text. */
  private open(selectText = true): void {
    if (this.input.disabled) return;
    this.opened = true;
    this.input.setAttribute("aria-expanded", "true");
    this.config.styleField?.(this.input, null); // typed text reads in the UI font
    this.filter("");
    const key = this.current === null ? null : this.config.key(this.current);
    this.setActive(this.shown.findIndex((i) => this.config.key(i) === key));
    if (selectText) this.input.select();
  }

  private closeList(): void {
    this.opened = false;
    this.list.hidden = true;
    this.empty.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
    this.showCurrent();
  }

  private optionOf(item: T | undefined): HTMLLIElement | undefined {
    return item === undefined ? undefined : this.options.get(this.config.key(item));
  }

  /** Show the items matching `query`, highlighting the first. */
  private filter(query: string): void {
    this.setActive(-1); // unmark the highlighted option of the previous list
    this.shown = this.config.match(this.items, query);
    this.list.replaceChildren(...this.shown.map((i) => this.optionOf(i)!));
    this.list.hidden = this.shown.length === 0;
    this.empty.hidden = this.shown.length > 0;
    this.setActive(this.shown.length > 0 ? 0 : -1);
  }

  /** Where `option` sits in the shown list, or -1. */
  private indexOf(option: HTMLLIElement | null): number {
    return option ? this.shown.findIndex((i) => this.config.key(i) === option.dataset.key) : -1;
  }

  /** Highlight the shown item at `index` (-1: none); `reveal` scrolls it into view. */
  private setActive(index: number, reveal = true): void {
    this.optionOf(this.shown[this.active])?.setAttribute("aria-selected", "false");
    this.active = index;
    const li = this.optionOf(this.shown[index]);
    if (!li) {
      this.input.removeAttribute("aria-activedescendant");
      return;
    }
    li.setAttribute("aria-selected", "true");
    this.input.setAttribute("aria-activedescendant", li.id);
    if (reveal) li.scrollIntoView({ block: "nearest" });
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
      const item = this.shown[this.active];
      if (item === undefined) return;
      this.choose(item);
    } else if (e.key === "Escape") this.dismiss(); // reverts; a dialog around it stays open
    else return;
    e.preventDefault();
  }

  /** Close the list, showing the current item again. */
  private dismiss(): void {
    if (this.config.releaseFocusOnPick) this.input.blur();
    else this.closeList();
  }

  /** Pick `item`: close the list, report a change. */
  private choose(item: T): void {
    const changed = this.current === null || this.config.key(item) !== this.config.key(this.current);
    this.current = item;
    this.dismiss();
    if (changed) this.changed?.(item);
  }
}

import { el } from "../ui";

/**
 * Pack Manager placeholder. The Pack Manager UI arrives with SPM-3 on top of
 * the Library core (SPM-2): pack list/create, Draft/Live toggle, ordered
 * sticker grid, emoji edit/copy, bulk import, and the rest of SPEC §5.
 */
export function renderPackManager(): HTMLElement {
  return el(
    "section",
    { class: "view" },
    el("h1", {}, "Pack Manager"),
    el(
      "p",
      { class: "muted" },
      "Database and file operations organizing stickers into packs.",
    ),
    el(
      "div",
      { class: "placeholder" },
      el("p", {}, "The Pack Manager is not part of the scaffold."),
      el(
        "p",
        { class: "muted" },
        "It arrives with SPM-3 (Pack Manager UI) on top of SPM-2 (Library core): packs, order-encoded filenames, desync detection, and the Missing state.",
      ),
    ),
  );
}
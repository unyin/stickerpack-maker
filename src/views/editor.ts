import { el } from "../ui";

/**
 * Editor placeholder. The canvas editor arrives with the Editor foundation
 * work package (SPM-5); the canvas library choice is deliberately deferred
 * (SPEC §9, own ADR at implementation time).
 */
export function renderEditor(): HTMLElement {
  return el(
    "section",
    { class: "view" },
    el("h1", {}, "Editor"),
    el(
      "p",
      { class: "muted" },
      "Image editing to produce finished stickers and thumbnails.",
    ),
    el(
      "div",
      { class: "placeholder" },
      el("p", {}, "The canvas editor is not part of the scaffold."),
      el(
        "p",
        { class: "muted" },
        "It arrives with the Editor foundation work package (SPM-5): import pipeline, layers, undo/redo, crop and sizing, effects, and the save pipeline.",
      ),
    ),
  );
}
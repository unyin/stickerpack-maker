// The pack view's side panel (SPEC §5): one selection -> panel paradigm for
// stickers, Missing stickers, and the thumbnail. Single selection shows the
// detail panel, several the aggregate panel, the thumbnail slot its own.
import { explorerLabel, icon } from "../../icons";
import { el } from "../../ui";
import type { PackView, StickerView } from "../api";
import { emojiCount, emojiWarning, EMOJI_MAX } from "../model/emoji";
import {
  combinedSize,
  dimensionsText,
  formatBytes,
  MISSING_BANNER,
  MISSING_REASON,
  sendBlocker,
  stickerCountText,
  thumbnailFormat,
} from "../model/messages";
import { previewImage, type Previews } from "./previews";

const COPY_TITLE = "Copy to clipboard";

/** What the panels ask the pack view to do. */
export interface PanelActions {
  edit(sticker: StickerView): void;
  replace(sticker: StickerView): void;
  send(stickers: StickerView[]): void;
  reveal(sticker: StickerView): void;
  remove(stickers: StickerView[]): void;
  saveEmoji(sticker: StickerView, emojiString: string): Promise<void>;
  revealThumbnail(): void;
}

function action(label: string | Array<Node | string>, onClick: () => void, reason: string | null, title: string, variant = "secondary"): HTMLButtonElement {
  const button = el("button", { class: variant, type: "button" }, ...[label].flat()) as HTMLButtonElement;
  button.addEventListener("click", onClick);
  button.disabled = reason !== null;
  button.title = reason ?? title;
  return button;
}

function meta(rows: Array<[string, string]>): HTMLElement {
  return el("dl", { class: "pm-meta" }, ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

/** Empty panel: how selection and import work. */
export function emptyPanel(reorder: boolean): HTMLElement {
  return el(
    "div",
    { class: "pm-panel-empty" },
    reorder
      ? el("p", {}, "Reorder mode: drag a sticker to its new place, one at a time. Files are renamed to match. Press Esc or Done to finish.")
      : el("p", {}, "Click a sticker to see its details. Ctrl+click adds or removes one, Shift+click selects a range, Esc clears."),
    el("p", { class: "muted" }, "Drop PNG or WEBP stickers onto the pack to add them at the end."),
  );
}

/** Detail panel: one sticker (SPEC §5). */
export function detailPanel(sticker: StickerView, previews: Previews, actions: PanelActions): HTMLElement {
  const missing = sticker.missing;
  const preview = missing
    ? el("div", { class: "pm-missing-art large" }, "File Missing")
    : previewImage(previews.sticker(sticker.id, sticker.format), `Sticker ${sticker.position}`, "pm-detail-img");

  // A full-width two-row box (about 11 emoji per row) that shows all 20 emoji
  // at once (owner, 2026-11-21). No line breaks: Enter finishes, and the core
  // strips every whitespace.
  const input = el("textarea", {
    class: "pm-input pm-emoji-input",
    rows: "2",
    spellcheck: "false",
    placeholder: "Type emoji, or Win+. for the emoji panel",
    id: "pm-emoji-input",
  }) as HTMLTextAreaElement;
  input.value = sticker.emojiString;
  const count = el("span", { class: "pm-emoji-count", "aria-live": "polite" });
  const warning = el("p", { class: "pm-warning-text", "aria-live": "polite" });
  const live = () => {
    count.textContent = `${emojiCount(input.value)} / ${EMOJI_MAX}`;
    const text = emojiWarning(input.value);
    warning.textContent = text ?? "";
    warning.hidden = text === null;
    input.classList.toggle("warn", text !== null);
  };
  input.addEventListener("input", live);
  input.addEventListener("change", () => void actions.saveEmoji(sticker, input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault(); // no line breaks in an Emoji String
      input.blur();
    }
  });
  live();
  const copy = el(
    "button",
    { class: "secondary pm-copy", type: "button", title: COPY_TITLE, "aria-label": "Copy the Emoji String to the clipboard" },
    icon("copy"),
  ) as HTMLButtonElement;
  // Polite live region: the icon swap alone is invisible to screen readers.
  const copyStatus = el("span", { class: "sr-only", role: "status" });
  const flash = copyFlash(copy, copyStatus);
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(input.value).then(
      () => flash("Copied", true),
      () => flash("Copy failed", false),
    );
  });

  const missingReason = missing ? MISSING_REASON : null;
  const banner = missing
    ? el(
        "div",
        { class: "pm-banner pm-banner-warn", role: "alert" },
        el("p", {}, MISSING_BANNER),
        el(
          "div",
          { class: "actions" },
          action("Replace file…", () => actions.replace(sticker), null, "Choose a valid sticker file to put in this slot", "primary"),
          action("Delete slot", () => actions.remove([sticker]), null, "Remove this slot; the stickers after it move up", "danger"),
        ),
      )
    : null;

  return el(
    "div",
    { class: "pm-detail" },
    ...(banner ? [banner] : []),
    el("div", { class: "pm-detail-preview" }, preview),
    meta([
      ["Position", `#${sticker.position}`],
      ["Format", sticker.format.toUpperCase()],
      ["Dimensions", dimensionsText(sticker.file)],
      ["File size", sticker.file ? formatBytes(sticker.file.bytes) : "—"],
      ["File", sticker.fileName],
    ]),
    el(
      "div",
      { class: "pm-emoji-row" },
      el("label", { class: "field-label", for: "pm-emoji-input" }, "Emoji String"),
      el("div", { class: "pm-emoji-actions" }, copyStatus, copy),
    ),
    input,
    el("div", { class: "pm-emoji-status" }, count, warning),
    el(
      "div",
      { class: "actions pm-panel-actions" },
      action("Edit", () => actions.edit(sticker), missingReason, "Open this sticker's image in the Editor"),
      action("Replace…", () => actions.replace(sticker), null, "Replace the image with a valid sticker file; position and emoji stay"),
      action("Send to pack…", () => actions.send([sticker]), sendBlocker([sticker]), "Copy or move this sticker to another pack"),
      action(explorerLabel(), () => actions.reveal(sticker), missingReason, "Open the pack folder in Explorer with this file selected"),
      action("Delete", () => actions.remove([sticker]), null, "Delete this sticker (Delete key)", "danger"),
    ),
  );
}

/** Aggregate panel: several stickers; exactly Send to pack and Delete (SPEC §5). */
export function aggregatePanel(stickers: StickerView[], actions: PanelActions): HTMLElement {
  return el(
    "div",
    { class: "pm-aggregate" },
    el("h2", {}, `${stickerCountText(stickers.length)} selected`),
    meta([["Combined size", combinedSize(stickers)]]),
    el(
      "div",
      { class: "actions pm-panel-actions" },
      action("Send to pack…", () => actions.send(stickers), sendBlocker(stickers), "Copy or move these stickers to another pack"),
      action("Delete", () => actions.remove(stickers), null, "Delete these stickers (Delete key)", "danger"),
    ),
    el("p", { class: "muted pm-hint" }, "Edit, Replace and Open in explorer work on one sticker: click a single sticker."),
  );
}

// TODO(SPM-12): Create (new image or a copy of a pack sticker, via the
// Editor's Thumbnail mode), Replace and Delete land with thumbnail CRUD; the
// Library core has no thumbnail operations yet.
const THUMBNAIL_SEAM = "Thumbnails are made in the Editor's Thumbnail mode, which is not available yet";

/** Thumbnail panel: the same paradigm minus emoji and position (SPEC §5). */
export function thumbnailPanel(view: PackView, previews: Previews, actions: PanelActions): HTMLElement {
  const name = view.pack.thumbnail;
  const file = view.thumbnailFile;
  const format = thumbnailFormat(name);
  const body: HTMLElement[] = [el("h2", {}, "Thumbnail")];
  if (view.thumbnailMissing) {
    body.push(
      el(
        "div",
        { class: "pm-banner pm-banner-warn", role: "alert" },
        el("p", {}, `Missing: ${name} is not in the pack folder. Replace or delete it once thumbnails can be edited.`),
      ),
    );
  }
  if (file && name) {
    body.push(
      el("div", { class: "pm-detail-preview" }, previewImage(previews.thumbnailOf(view.pack.id, format), "Thumbnail", "pm-detail-img")),
      meta([
        ["Format", format.toUpperCase()],
        ["Dimensions", dimensionsText(file)],
        ["File size", formatBytes(file.bytes)],
        ["File", name],
      ]),
    );
  } else if (!name) {
    body.push(el("p", { class: "muted" }, "This pack has no thumbnail."));
  }
  body.push(
    el(
      "div",
      { class: "actions pm-panel-actions" },
      action(name ? "Replace…" : "Create…", () => {}, THUMBNAIL_SEAM, ""),
      ...(name ? [action("Delete", () => {}, THUMBNAIL_SEAM, "", "danger")] : []),
      action(explorerLabel(), () => actions.revealThumbnail(), file ? null : "There is no thumbnail file to show", "Open the pack folder in Explorer with the thumbnail selected"),
    ),
  );
  return el("div", { class: "pm-thumb-panel" }, ...body);
}

/** Briefly show the copy result: check icon on success, a red button on failure, and a screen-reader announcement. */
function copyFlash(button: HTMLButtonElement, status: HTMLElement): (text: string, ok: boolean) => void {
  let restore: ReturnType<typeof setTimeout> | undefined; // per panel, like the button it restores
  return (text, ok) => {
    clearTimeout(restore); // a second click restarts the timer instead of leaving "Copied" stuck
    button.title = text;
    status.textContent = text;
    button.classList.toggle("failed", !ok);
    button.replaceChildren(icon(ok ? "check" : "copy"));
    restore = setTimeout(() => {
      button.title = COPY_TITLE;
      status.textContent = "";
      button.classList.remove("failed");
      button.replaceChildren(icon("copy"));
    }, 1200);
  };
}

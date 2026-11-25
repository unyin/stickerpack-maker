// The pack view's side panel (SPEC §5): one selection -> panel paradigm for
// stickers, Missing stickers, and the thumbnail. Single selection shows the
// detail panel, several the aggregate panel, the thumbnail slot its own.
import { explorerLabel } from "../../icons";
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
import { bindEmojiSave, copyButton, measureEmojiGlyph } from "./emoji-field";
import { previewImage, type Previews } from "./previews";

/** Box width in glyph widths: five per row fit, six do not, with room for spacing. */
const EMOJI_BOX_GLYPH_WIDTHS = 5.5;

/** First-paint width in px: EMOJI_BOX_GLYPH_WIDTHS × 30 px, about Segoe UI Emoji at 24 px. Keep in step with `.pm-emoji-input` in pack-manager.css. */
const EMOJI_BOX_FALLBACK_WIDTH = 165;

/** What the panels ask the pack view to do. */
export interface PanelActions {
  edit(sticker: StickerView): void;
  replace(sticker: StickerView): void;
  send(stickers: StickerView[]): void;
  reveal(sticker: StickerView): void;
  remove(stickers: StickerView[]): void;
  saveEmoji(sticker: StickerView, emojiString: string): Promise<void>;
  revealThumbnail(): void;
  editThumbnail(): void;
  removeThumbnail(): void;
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
      ? el("p", {}, "Reorder mode: drag a sticker to its new place, one at a time. Selection is off. Files are renamed to match. Press Esc or Done to finish.")
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

  // Four rows of five: all 20 emoji show at once (owner, 2026-11-21); emojiBoxWidth
  // sizes the box for five per row. No line breaks: Enter finishes, and the
  // core strips every whitespace.
  const input = el("textarea", {
    class: "pm-input pm-emoji-input",
    rows: "4",
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
  // Grow instead of scrolling past 20 emoji: a scrollbar would narrow the box
  // and drop the rows to four emoji.
  const fitHeight = () => {
    input.style.height = "";
    if (input.scrollHeight > input.clientHeight) {
      // content-box: style.height is the content height, so leave out the padding.
      const cs = getComputedStyle(input);
      input.style.height = `${input.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)}px`;
    }
  };
  input.addEventListener("input", () => {
    live();
    fitHeight();
  });
  // Once on screen (and again when fonts finish loading): size for five per row, then fit the height.
  const fit = () => {
    if (!input.isConnected) return;
    // The font shorthand can compute to "" (a canvas then ignores it), so build it from its parts.
    const cs = getComputedStyle(input);
    input.style.width = `${emojiBoxWidth(cs.fontSize, cs.fontFamily)}px`;
    fitHeight();
  };
  requestAnimationFrame(fit);
  void document.fonts.ready.then(fit);
  bindEmojiSave(input, (value) => void actions.saveEmoji(sticker, value));
  live();
  const { button: copy, status: copyStatus } = copyButton(() => input.value, "Copy the Emoji String to the clipboard");

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
    el("label", { class: "field-label pm-emoji-label", for: "pm-emoji-input" }, "Emoji String"),
    el("div", { class: "pm-emoji-row" }, input, el("div", { class: "pm-emoji-side" }, copy, copyStatus, count)),
    warning,
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
        el("p", {}, `Missing: ${name} is not in the pack folder.`),
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
      action(
        name ? "Replace…" : "Create…",
        () => actions.editThumbnail(),
        null,
        "Make this pack's thumbnail in the Editor, from a new image or a copy of a sticker",
      ),
      ...(name
        ? [action("Delete", () => actions.removeThumbnail(), null, "Delete the thumbnail and its file; the pack's stickers are kept", "danger")]
        : []),
      action(explorerLabel(), () => actions.revealThumbnail(), file ? null : "There is no thumbnail file to show", "Open the pack folder in Explorer with the thumbnail selected"),
    ),
  );
  return el("div", { class: "pm-thumb-panel" }, ...body);
}

/**
 * Content width of the Emoji String box for five emoji per row (owner,
 * 2026-11-21). A textarea wraps by width, not by count, so size it from the
 * measured glyph: EMOJI_BOX_GLYPH_WIDTHS glyph widths fit five per row but not
 * six. Falls back when the glyph cannot be measured (measureEmojiGlyph).
 */
function emojiBoxWidth(fontSize: string, fontFamily: string): number {
  const glyph = measureEmojiGlyph(fontSize, fontFamily);
  return glyph === null ? EMOJI_BOX_FALLBACK_WIDTH : Math.ceil(glyph * EMOJI_BOX_GLYPH_WIDTHS);
}

// The pack view (SPEC §5): header (Title, Short Name, Draft/Live), toolbar
// (Reorder toggle, Refresh, Add images), banners, the sticker grid with the
// thumbnail slot at its end, and the selection panel. Rules live in
// ../model; this file wires them to the DOM and the commands.
import { stickerOrigin, type StickerOrigin } from "../../shared/sticker-origin";
import { takeChangedStickers } from "../model/changed-files";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { editorCanImport } from "../../shared/import-extensions";
import { explorerLabel, icon } from "../../icons";
import { el, errorMessage, onActivate, withMessage } from "../../ui";
import {
  checkStickerFile,
  deleteStickers,
  importStickers,
  loadPackView,
  openPack,
  pickStickerFiles,
  reorderSticker,
  replaceSticker,
  revealPack,
  revealSticker,
  revealThumbnail,
  setEmojiString,
  setPackShortName,
  setPackStatus,
  setPackTitle,
  stickerFilePath,
  type FileError,
  type PackView,
  type StickerView,
} from "../api";
import {
  fileNameOf,
  importSummary,
  missingSummary,
  SHORT_NAME_LOCKED,
  stickerCountText,
  thumbnailFormat,
  warningText,
} from "../model/messages";
import { escapeAction, selectionActive, toggleMode, type Mode } from "../model/modes";
import {
  clickSticker,
  clickThumbnail,
  modifiersOf,
  NO_SELECTION,
  panelFor,
  pruneSelection,
  type SelectionState,
} from "../model/selection";
import { emojiCountWarning, emojiWarning } from "../model/emoji";
import { importOrder } from "../model/import-order";
import { rustTrim, shortNameProblem, titleProblem } from "../model/names";
import { dialogOpen } from "../../dialog";
import { confirmGoLive, confirmRevertToDraft, confirmStickerDelete, editChoiceDialog, invalidFileDialog, sendDialog, statusBadge } from "./dialogs";
import { aggregatePanel, detailPanel, emptyPanel, thumbnailPanel, type PanelActions } from "./panels";
import { previewImage, Previews } from "./previews";
import { cancelReorderDrag, startReorderDrag, type ReorderDragHost } from "./reorder-drag";

export interface PackViewHost {
  /** Back to the pack list. */
  back(): void;
  /** Show the Editor with this image open; `origin` when it is this pack's sticker (Edit). */
  openInEditor(path: string, origin?: StickerOrigin): void;
}

export interface PackViewHandle {
  element: HTMLElement;
  /** Re-read the pack without a Missing scan (e.g. the Editor saved into it). */
  reload(): void;
  /**
   * Show sticker `id` (the Editor's saved-note link): re-read the pack unless
   * `fresh` (just opened), then Normal mode, that sticker alone selected
   * (detail panel), scrolled into view. Runs like every pack action: one at
   * a time, errors (and a sticker gone meanwhile) in the message line.
   */
  reveal(id: number, fresh: boolean): void;
  destroy(): void;
}

/** Open a pack (recovery + desync detection) and build its view. */
export async function buildPackView(packId: number, host: PackViewHost): Promise<PackViewHandle> {
  let view: PackView = await openPack(packId);
  let mode: Mode = "normal";
  let selection: SelectionState = NO_SELECTION;
  let busy = false;
  let rejected: FileError[] = [];
  let notice = "";
  const previews = new Previews();

  const message = el("p", { class: "message", role: "alert" });
  const titleInput = el("input", { class: "pm-input pm-title-input", type: "text", "aria-label": "Title" }) as HTMLInputElement;
  const shortInput = el("input", {
    class: "pm-input pm-mono",
    type: "text",
    spellcheck: "false",
    "aria-label": "Short Name",
  }) as HTMLInputElement;
  // Beside the "Short Name" label, so showing it never changes the header's height (owner, 2026-11-22).
  const shortNote = el("span", { class: "muted pm-lock-note" });
  const badgeHost = el("span", {});
  const statusButton = el("button", { class: "secondary", type: "button" }) as HTMLButtonElement;
  const backButton = el("button", { class: "secondary", type: "button", title: "Back to the list of packs" }, "← Pack list") as HTMLButtonElement;
  const reorderButton = el("button", { class: "secondary pm-toggle", type: "button", "aria-pressed": "false" }, "Reorder") as HTMLButtonElement;
  const refreshButton = el("button", { class: "secondary", type: "button", title: "Check the pack folder for files changed outside the app" }, icon("refresh"), "Refresh") as HTMLButtonElement;
  const addButton = el("button", { class: "secondary", type: "button", title: "Add sticker files at the end of the pack (or drop them onto the pack)" }, "Add images…") as HTMLButtonElement;
  // Fixed width so nothing after it moves (why that width: .pm-sticker-count in pack-manager.css).
  const stickerCount = el("span", { class: "muted pm-sticker-count" });
  const revealButton = el("button", { class: "secondary", type: "button", title: "Open this pack's folder in Explorer" }, ...explorerLabel()) as HTMLButtonElement;
  const banners = el("div", { class: "pm-banners" });
  const grid = el("ol", { class: "pm-grid", "aria-label": "Stickers in pack order" });
  const panel = el("aside", { class: "pm-panel", "aria-label": "Selection" });
  const dropZone = el("div", { class: "pm-body" }, grid, panel);

  const header = el(
    "div",
    { class: "pm-header" },
    backButton,
    el("label", { class: "pm-header-field" }, el("span", { class: "field-label" }, "Title"), titleInput),
    el("label", { class: "pm-header-field pm-short-field" }, el("span", { class: "pm-field-head" }, el("span", { class: "field-label" }, "Short Name"), shortNote), shortInput),
    el("div", { class: "pm-header-status" }, badgeHost, statusButton),
  );
  // Reorder last: its label changes ("Done reordering"), so nothing may come after it (owner, 2026-11-22).
  const toolbar = el("div", { class: "pm-toolbar", role: "toolbar" }, refreshButton, addButton, stickerCount, revealButton, reorderButton);
  const root = el("section", { class: "view pm-pack" }, header, toolbar, message, banners, dropZone);

  /** Run one Library action at a time, routing errors into the message line. */
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    root.classList.add("busy");
    try {
      await withMessage(message, action);
    } finally {
      busy = false;
      root.classList.remove("busy");
      render();
    }
  }

  function setView(next: PackView): void {
    view = next;
    selection = pruneSelection(selection, order());
  }

  function order(): number[] {
    return view.stickers.map((s) => s.id);
  }

  function selected(): StickerView[] {
    return view.stickers.filter((s) => selection.ids.includes(s.id));
  }

  // ---- Header ----

  // No `maxlength`: it counts UTF-16 units; the limit counts characters like the core.
  const markField = (input: HTMLInputElement, problem: string | null): void => {
    input.setAttribute("aria-invalid", String(problem !== null));
  };
  const checkField = (input: HTMLInputElement, problem: string | null): void => {
    markField(input, problem);
    message.textContent = problem ?? "";
  };
  titleInput.addEventListener("input", () => checkField(titleInput, titleProblem(titleInput.value)));
  shortInput.addEventListener("input", () => checkField(shortInput, shortNameProblem(shortInput.value, { allowEmpty: false })));

  titleInput.addEventListener("change", () =>
    void run(async () => {
      try {
        const why = titleProblem(titleInput.value);
        if (why) throw new Error(why); // blocked, reason shown in the message line
        view = { ...view, pack: await setPackTitle(packId, titleInput.value) };
      } finally {
        titleInput.value = view.pack.title;
        markField(titleInput, null);
      }
    }),
  );
  shortInput.addEventListener("change", () =>
    void run(async () => {
      try {
        const why = shortNameProblem(shortInput.value, { allowEmpty: false });
        if (why) throw new Error(why);
        view = { ...view, pack: await setPackShortName(packId, rustTrim(shortInput.value)) };
        previews.clear(); // the folder moved
        if (view.pack.folderRenameFrom) {
          notice = "The Short Name changed, but the folder could not be renamed yet (it may be open in Explorer). Close it and press Refresh.";
        }
      } finally {
        shortInput.value = view.pack.shortName;
        markField(shortInput, null);
      }
    }),
  );
  for (const input of [titleInput, shortInput]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    });
  }
  statusButton.addEventListener("click", () =>
    void run(async () => {
      const toLive = view.pack.status === "draft";
      const ok = toLive
        ? await confirmGoLive()
        : await confirmRevertToDraft();
      if (!ok) return;
      view = { ...view, pack: await setPackStatus(packId, toLive ? "live" : "draft") };
    }),
  );
  backButton.addEventListener("click", () => host.back());
  revealButton.addEventListener("click", () => void run(() => revealPack(packId)));

  // ---- Toolbar ----

  function setMode(next: Mode): void {
    mode = next;
    // Selection belongs to Normal mode; Reorder starts from a clean slate.
    if (mode === "reorder") selection = NO_SELECTION;
    render();
  }
  reorderButton.addEventListener("click", () => setMode(toggleMode(mode)));
  refreshButton.addEventListener("click", () =>
    void run(async () => {
      previews.clear();
      setView(await openPack(packId));
      const missing = view.stickers.filter((s) => s.missing).length;
      notice = missing ? `Checked the pack folder: ${missing} Missing.` : "Checked the pack folder: every file is in place.";
    }),
  );
  addButton.addEventListener("click", () =>
    void run(async () => {
      const paths = await pickStickerFiles(true, "Add stickers to this pack");
      if (paths.length) await importPaths(paths);
    }),
  );

  // ---- Bulk import (SPEC §5) ----

  /** Import in natural filename order, whatever order the files came in (owner decision 2026-11-21). */
  async function importPaths(paths: string[]): Promise<void> {
    const result = await importStickers(packId, importOrder(paths));
    setView(result.view);
    rejected = result.rejected;
    notice = importSummary(result.addedIds.length, result.rejected.length);
  }

  let unlistenDrop: (() => void) | null = null;
  getCurrentWebview()
    .onDragDropEvent((event) => {
      if (!root.isConnected || dialogOpen()) return;
      const payload = event.payload;
      if (payload.type === "over" || payload.type === "enter") dropZone.classList.add("drop-target");
      else if (payload.type === "leave") dropZone.classList.remove("drop-target");
      else if (payload.type === "drop") {
        dropZone.classList.remove("drop-target");
        if (payload.paths.length) void run(() => importPaths(payload.paths));
      }
    })
    .then((unlisten) => (unlistenDrop = unlisten))
    .catch(() => {});

  // ---- Panel actions ----

  async function replace(sticker: StickerView): Promise<void> {
    const [path] = await pickStickerFiles(false, `Replace sticker #${sticker.position}`);
    if (!path) return;
    try {
      await checkStickerFile(path);
    } catch (err) {
      if (await invalidFileDialog(path, errorMessage(err))) host.openInEditor(path);
      return;
    }
    const next = await replaceSticker(sticker.id, path);
    previews.forget(sticker.id);
    setView(next);
    notice = `Sticker #${sticker.position} replaced.`;
  }

  async function remove(stickers: StickerView[]): Promise<void> {
    if (!(await confirmStickerDelete(stickers, previews))) return;
    setView(await deleteStickers(packId, stickers.map((s) => s.id)));
    notice = `Deleted ${stickerCountText(stickers.length)}.`;
  }

  const actions: PanelActions = {
    // Edit first asks Edit / Replace / Cancel (owner decision 2026-11-21).
    edit: (s) =>
      void run(async () => {
        const choice = await editChoiceDialog(s.position);
        if (choice === "edit") {
          // Saving the session then offers to replace this sticker (owner decision 2026-11-22).
          host.openInEditor(await stickerFilePath(s.id), stickerOrigin(s, view.pack.title));
        }
        else if (choice === "replace") await replace(s);
      }),
    replace: (s) => void run(() => replace(s)),
    send: (stickers) =>
      void run(async () => {
        const sent = await sendDialog(packId, stickers);
        if (!sent) return;
        if (sent.report.originalsDeleted) {
          // Moved stickers left this pack: reload the rows, no Missing scan.
          previews.clear();
          setView(await loadPackView(packId));
        }
        notice = sent.text;
      }),
    reveal: (s) => void run(() => revealSticker(s.id)),
    remove: (stickers) => void run(() => remove(stickers)),
    // Not behind the busy guard: the change event fires on blur, often from
    // the very click that starts another action, and must never be dropped.
    // The Rust LibraryLock serializes it with that action.
    saveEmoji: async (s, emojiString) => {
      try {
        const saved = await setEmojiString(s.id, emojiString);
        view = {
          ...view,
          stickers: view.stickers.map((x) =>
            x.id === saved.id ? { ...x, emojiString: saved.emojiString, emojiWarning: emojiCountWarning(saved.emojiString) } : x,
          ),
        };
      } catch (err) {
        message.textContent = errorMessage(err);
      }
      render();
    },
    revealThumbnail: () => void run(() => revealThumbnail(packId)),
  };

  // ---- Grid ----

  function tile(sticker: StickerView): HTMLElement {
    const isSelected = selection.ids.includes(sticker.id);
    const art = sticker.missing
      ? el("div", { class: "pm-missing-art" }, "Missing")
      : previewImage(previews.sticker(sticker.id, sticker.format), `Sticker ${sticker.position}`, "pm-tile-img");
    // One flag per tile, Missing first: two don't fit on a tile (owner, 2026-11-22).
    const flags: HTMLElement[] = [];
    if (sticker.missing) flags.push(el("span", { class: "pm-flag pm-flag-missing", title: "The file is not in the pack folder" }, "⚠ Missing"));
    else if (sticker.emojiWarning) {
      flags.push(
        el(
          "span",
          { class: "pm-flag pm-flag-emoji", title: emojiWarning(sticker.emojiString) ?? "" },
          sticker.emojiString === "" ? "No emoji" : "Emoji",
        ),
      );
    }
    const item = el(
      "li",
      {
        class: ["pm-tile", isSelected ? "selected" : "", sticker.missing ? "missing" : ""].join(" ").trim(),
        "data-id": String(sticker.id),
        tabindex: "0",
        "aria-selected": String(isSelected),
        "aria-label": `Sticker ${sticker.position}${sticker.missing ? ", Missing" : ""}`,
      },
      el("span", { class: "pm-pos" }, String(sticker.position)),
      art,
      el("span", { class: "pm-flags" }, ...flags),
    );
    item.addEventListener("click", (e) => {
      if (!selectionActive(mode)) return;
      selection = clickSticker(selection, order(), sticker.id, modifiersOf(e));
      render();
    });
    onActivate(item, (e) => {
      if (!selectionActive(mode)) return;
      selection = clickSticker(selection, order(), sticker.id, modifiersOf(e));
      render();
    });
    item.addEventListener("pointerdown", (e) => startReorderDrag(e, sticker.id, reorderHost));
    return item;
  }

  function thumbnailTile(): HTMLElement {
    const name = view.pack.thumbnail;
    const format = thumbnailFormat(name);
    const art =
      name && view.thumbnailFile
        ? previewImage(previews.thumbnailOf(packId, format), "Thumbnail", "pm-tile-img")
        : el("div", { class: "pm-thumb-empty" }, name ? "Missing" : "No thumbnail");
    const item = el(
      "li",
      {
        class: ["pm-tile", "pm-thumb-slot", selection.thumbnail ? "selected" : "", view.thumbnailMissing ? "missing" : ""].join(" ").trim(),
        tabindex: "0",
        "aria-selected": String(selection.thumbnail),
        "aria-label": "Thumbnail",
      },
      el("span", { class: "pm-thumb-label" }, "Thumbnail"),
      art,
      ...(view.thumbnailMissing ? [el("span", { class: "pm-flags" }, el("span", { class: "pm-flag pm-flag-missing" }, "⚠ Missing"))] : []),
    );
    const choose = () => {
      if (!selectionActive(mode)) return;
      selection = clickThumbnail();
      render();
    };
    item.addEventListener("click", choose);
    onActivate(item, choose);
    return item;
  }

  // ---- Reorder drag (pointer events, see ./reorder-drag) ----

  const reorderHost: ReorderDragHost = {
    grid,
    enabled: () => mode === "reorder" && !busy,
    indexOf: (id: number) => view.stickers.findIndex((s) => s.id === id),
    drop: (id: number, from: number, position: number) =>
      void run(async () => {
        setView(await reorderSticker(id, position));
        notice = `Moved sticker #${from + 1} to #${position}; files renamed to match.`;
      }),
  };

  // ---- Keyboard: Esc and Delete (SPEC §5) ----

  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected || dialogOpen() || busy) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (e.key === "Escape") {
      if (escapeAction(mode) === "exit-reorder") setMode("normal");
      else {
        selection = NO_SELECTION;
        render();
      }
    } else if (e.key === "Delete" && selectionActive(mode) && selection.ids.length > 0) {
      actions.remove(selected());
    } else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey);

  // ---- Render ----

  /**
   * A dismissible banner: an X on the left (owner, 2026-11-22: the Dismiss
   * link alone sits far away on the right), the message, then Dismiss.
   * Either one runs `clear` to reset the banner's state, then re-renders.
   * The live-region role sits on the message only, so a screen reader
   * announces the message, not the two Dismiss controls.
   */
  function dismissibleBanner(
    kind: "info" | "warn",
    role: "status" | "alert",
    body: Array<Node | string>,
    clear: () => void,
    extraClass = "",
  ): HTMLElement {
    const dismiss = () => {
      clear();
      render();
    };
    const close = el("button", { class: "pm-banner-close", type: "button", title: "Dismiss", "aria-label": "Dismiss this message" }, icon("close"));
    const link = el("button", { class: "pm-link", type: "button" }, "Dismiss");
    close.addEventListener("click", dismiss);
    link.addEventListener("click", dismiss);
    const classes = ["pm-banner", `pm-banner-${kind}`, extraClass].filter(Boolean).join(" ");
    return el("div", { class: classes }, close, el("div", { class: "pm-banner-body", role }, ...body), link);
  }

  function renderBanners(): void {
    const items: HTMLElement[] = [];
    const size = warningText(view.packSizeWarning);
    if (size) items.push(el("div", { class: "pm-banner pm-banner-warn", role: "status" }, size));
    const missing = missingSummary(view.stickers.filter((s) => s.missing).length);
    if (missing) items.push(el("div", { class: "pm-banner pm-banner-warn", role: "status" }, missing));
    if (notice) {
      items.push(dismissibleBanner("info", "status", [notice], () => (notice = "")));
    }
    if (rejected.length) {
      items.push(
        dismissibleBanner(
          "warn",
          "alert",
          [
            el("strong", {}, "Not added:"),
            el(
              "ul",
              {},
              ...rejected.map((r) => {
                const row = el("li", {}, el("span", { class: "pm-mono" }, fileNameOf(r.path)), ` ${r.reason}. `);
                // Only files the Editor can import get the button.
                if (editorCanImport(r.path)) {
                  const open = el("button", { class: "pm-link", type: "button" }, "Open in editor");
                  open.addEventListener("click", () => host.openInEditor(r.path));
                  row.append(open);
                }
                return row;
              }),
            ),
          ],
          () => (rejected = []),
          "pm-rejected",
        ),
      );
    }
    banners.replaceChildren(...items);
  }

  function renderPanel(): void {
    const kind = mode === "reorder" ? "none" : panelFor(selection);
    if (kind === "detail") panel.replaceChildren(detailPanel(selected()[0], previews, actions));
    else if (kind === "aggregate") panel.replaceChildren(aggregatePanel(selected(), actions));
    else if (kind === "thumbnail") panel.replaceChildren(thumbnailPanel(view, previews, actions));
    else panel.replaceChildren(emptyPanel(mode === "reorder"));
  }

  function render(): void {
    const pack = view.pack;
    const live = pack.status === "live";
    if (document.activeElement !== titleInput) titleInput.value = pack.title;
    if (document.activeElement !== shortInput) shortInput.value = pack.shortName;
    shortInput.disabled = live;
    shortInput.title = live ? SHORT_NAME_LOCKED : "Editable while Draft; renames the pack folder";
    shortNote.textContent = live ? "🔒 Locked" : ""; // short label (owner, 2026-11-22); the tooltip has the reason
    shortNote.title = live ? SHORT_NAME_LOCKED : ""; // the full reason, even if the note is ever cut off
    badgeHost.replaceChildren(statusBadge(pack.status));
    // Labels match the dialogs they open ("Go Live?" / "Revert to Draft?").
    statusButton.textContent = live ? "Revert to Draft" : "Go Live";
    statusButton.title = live
      ? "The pack does not exist on Telegram (unlocks the Short Name)"
      : "The pack now exists on Telegram (locks the Short Name)";
    const reorder = mode === "reorder";
    reorderButton.textContent = reorder ? "Done reordering" : "Reorder";
    reorderButton.setAttribute("aria-pressed", String(reorder));
    reorderButton.disabled = view.stickers.length < 2 && !reorder;
    reorderButton.title = reorderButton.disabled ? "Reordering needs at least two stickers" : "Drag stickers into a new order (Esc to finish)";
    stickerCount.textContent = stickerCountText(view.stickers.length);
    root.classList.toggle("reorder", reorder);
    for (const b of [refreshButton, addButton, revealButton, statusButton, backButton]) b.disabled = busy;
    titleInput.disabled = busy;
    if (busy) shortInput.disabled = true;

    // Keep focus on the tile the user was on across re-renders.
    const focusedId = (document.activeElement as HTMLElement | null)?.closest?.(".pm-tile")?.getAttribute("data-id");
    const thumbFocused = (document.activeElement as HTMLElement | null)?.classList?.contains("pm-thumb-slot");
    grid.replaceChildren(...view.stickers.map(tile), thumbnailTile());
    if (focusedId) grid.querySelector<HTMLElement>(`.pm-tile[data-id="${focusedId}"]`)?.focus();
    else if (thumbFocused) grid.querySelector<HTMLElement>(".pm-thumb-slot")?.focus();
    renderBanners();
    // Rebuilding the panel would drop a half-typed Emoji String: keep it while editing.
    const editing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
    if (!panel.contains(document.activeElement) || !editing) renderPanel();
  }

  /** Re-read the pack (no Missing scan); the Editor may have replaced a file, whose cached preview is stale. */
  async function reread(): Promise<void> {
    for (const id of takeChangedStickers()) previews.forget(id);
    setView(await loadPackView(packId));
  }

  render();
  return {
    element: root,
    reload: () => void run(reread),
    reveal: (id, fresh) =>
      void run(async () => {
        if (!fresh) await reread();
        if (!view.stickers.some((s) => s.id === id)) throw new Error("That sticker is no longer in this pack.");
        // Design decision 2026-11-22: the link leaves Reorder mode and replaces the selection.
        mode = "normal";
        selection = { ids: [id], thumbnail: false, anchor: id };
        render();
        const tile = grid.querySelector<HTMLElement>(`.pm-tile[data-id="${id}"]`);
        tile?.scrollIntoView({ block: "nearest" });
        tile?.focus({ preventScroll: true });
      }),
    destroy() {
      document.removeEventListener("keydown", onKey);
      unlistenDrop?.();
      cancelReorderDrag();
      previews.clear();
    },
  };
}

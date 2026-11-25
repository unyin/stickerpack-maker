// The pack list (SPEC §5): create, open, reorder, and delete packs. Each time
// it is shown, every pack gets the full open check (recovery, then desync
// detection; SPEC §4, ADR-0004), and each row reports what it found: a
// thumbnail, the Title and Short Name, a status badge that carries the pack's
// issues (model/pack-issues.ts, the same rule as the Pack view's Upload…
// button), the Draft/Live badge, Open in explorer, and Delete. The row's grip
// drags it to a new place in the stored display order (pack-list-drag.ts).
import { explorerLabel, icon } from "../../icons";
import { el, errorMessage } from "../../ui";
import {
  deletePack,
  listPackFacts,
  reorderPack,
  revealPack,
  type PackListEntry,
} from "../api";
import { noPackMatchText, packCountText, packDeleteMessage, thumbnailFormat } from "../model/messages";
import { statusBadgeOf } from "../model/pack-issues";
import { reorderAllowed, searchView } from "../model/pack-search";
import { rowClickOpens, rowThumbnail } from "../model/pack-row";
import { confirmChoice } from "../../dialog";
import { createPackDialog, statusBadge } from "./dialogs";
import { cancelRowDrag, packRows, rowClickSuppressed, startRowDrag } from "./pack-list-drag";
import { previewImage, Previews } from "./previews";

export function buildPackList(onOpen: (packId: number) => void): {
  element: HTMLElement;
  reload(): Promise<void>;
  /** Show an error in the list's message line. */
  showError(text: string): void;
  /** Empty the message line; the show path calls it before reload(). */
  clearMessage(): void;
} {
  const message = el("p", { class: "message", role: "alert" });
  // The ONE writer of the message line. Rule: a successful reload clears the
  // line only when a failed LOAD wrote it, so a delete/reorder/reveal error
  // or a showError message survives the reload that follows; each show of the
  // list starts clear (clearMessage, before reload).
  let loadFailed = false;
  function say(text: string, fromLoad = false): void {
    message.textContent = text;
    loadFailed = fromLoad && text !== "";
  }
  const notice = el("p", { class: "pm-notice", role: "status" });
  const list = el("ul", { class: "pm-pack-list" });
  // One preview cache per row (each pack has its own thumbnail and first sticker); dropped on every reload.
  let previews: Previews[] = [];
  const newButton = el("button", { class: "primary", type: "button" }, "New pack…") as HTMLButtonElement;
  // How many packs the Library holds.
  const packCount = el("span", { class: "pm-pack-count" });
  // Filters the list as you type (SPEC §5); type=search brings the webview's own clear button and Esc-to-clear.
  const search = el("input", {
    type: "search",
    class: "pm-input pm-search",
    placeholder: "Search packs",
    "aria-label": "Search packs by Title or Short Name",
  }) as HTMLInputElement;
  // The Library's packs as last loaded, in stored order; the search filters this copy, no reload.
  let packs: PackListEntry[] = [];
  const element = el(
    "section",
    { class: "view pm-list" },
    el(
      "div",
      { class: "pm-list-head" },
      el("div", { class: "pm-list-title" }, el("h1", {}, "Pack Manager"), packCount),
      el("div", { class: "pm-list-actions" }, search, newButton),
    ),
    el("p", { class: "muted" }, "Organise stickers into packs. Files are named in pack order, ready to drag into @Stickers."),
    message,
    notice,
    list,
  );

  // `input` covers typing and the clear button; `search` covers Esc-to-clear.
  search.addEventListener("input", applyFilter);
  search.addEventListener("search", applyFilter);

  newButton.addEventListener("click", async () => {
    const pack = await createPackDialog();
    if (pack) onOpen(pack.id);
  });

  async function remove(pack: PackListEntry): Promise<void> {
    const live = pack.status === "live";
    const ok = await confirmChoice(
      live ? "Delete this Live pack locally?" : "Delete this pack?",
      [
        el("p", {}, packDeleteMessage(pack.title, pack.status, pack.stickerCount)),
        ...(live ? [el("p", { class: "pm-warning-text" }, "This does not delete the pack on Telegram.")] : []),
      ],
      { actionLabel: live ? "Delete locally" : "Delete pack", keepLabel: "Cancel", danger: true },
    );
    if (!ok) return;
    say("");
    try {
      const leftover = await deletePack(pack.id);
      notice.textContent = leftover
        ? `“${pack.title}” is gone from the Library, but its folder could not be removed (${leftover.reason}). Delete ${leftover.path} yourself.`
        : `Deleted “${pack.title}”.`;
    } catch (err) {
      say(errorMessage(err));
    }
    await reload();
  }

  /** The thumbnail cell: its own thumbnail, the first sticker standing in, the Missing art, or nothing. */
  function thumbnailCell(pack: PackListEntry, cache: Previews): HTMLElement {
    const choice = rowThumbnail(pack);
    const cell = el("div", { class: "pm-row-thumb", title: choice.title });
    switch (choice.kind) {
      case "own":
        cell.append(previewImage(cache.thumbnailOf(pack.id, thumbnailFormat(pack.thumbnail)), "", "pm-row-img"));
        break;
      case "first":
        cell.classList.add("fallback");
        cell.append(previewImage(cache.sticker(choice.stickerId, pack.firstSticker?.format ?? "png"), "", "pm-row-img"));
        break;
      case "missing":
        cell.append(el("div", { class: "pm-missing-art" }, "Missing"));
        break;
      case "none":
        cell.append(el("div", { class: "pm-thumb-empty" }, "None"));
        break;
    }
    return cell;
  }

  /** The status badge: the pack's issues or Ready to upload; a failed check reads as its own issue. */
  function statusCell(pack: PackListEntry): HTMLElement {
    const cell = el("span", { class: "pm-status-cell" });
    if (pack.checkError !== null) {
      cell.append(el("span", { class: "pm-badge pm-badge-issue", title: pack.checkError }, "Check failed"));
      return cell;
    }
    const badge = statusBadgeOf(pack);
    if (badge) cell.append(el("span", { class: `pm-badge pm-badge-${badge.tone}`, title: badge.title }, badge.label));
    return cell;
  }

  function row(pack: PackListEntry): HTMLElement {
    const cache = new Previews();
    previews.push(cache);
    const grip = el("span", { class: "pm-grip", title: "Drag to reorder" }, icon("grip"));
    const open = el("button", { class: "pm-pack-open", type: "button", title: `Open this pack — ${pack.title} (${pack.shortName})` },
      el("span", { class: "pm-pack-title" }, pack.title),
      el("span", { class: "muted pm-mono" }, pack.shortName),
    );
    open.addEventListener("click", () => onOpen(pack.id));
    const folderLabel = `Open the folder of “${pack.title}” in Explorer`;
    const reveal = el(
      "button",
      { class: "secondary", type: "button", title: folderLabel, "aria-label": folderLabel },
      ...explorerLabel(),
    );
    reveal.addEventListener("click", () => {
      say("");
      revealPack(pack.id).catch((err) => say(errorMessage(err)));
    });
    const del = el("button", { class: "secondary", type: "button", title: "Delete this pack" }, "Delete");
    del.addEventListener("click", () => void remove(pack));
    const item = el(
      "li",
      { class: "pm-pack-row", "data-id": String(pack.id) },
      grip,
      thumbnailCell(pack, cache),
      open,
      statusCell(pack),
      statusBadge(pack.status),
      reveal,
      del,
    );
    // The whole row opens the pack, except the grip and the buttons (the
    // title button has its own handler). A handler, not an overlay: an overlay
    // would cover the thumbnail's and badges' tooltips.
    item.addEventListener("click", (e) => {
      const onControl = (e.target as Element).closest("button, .pm-grip") !== null;
      if (rowClickOpens({ onControl, endsDrag: rowClickSuppressed() })) onOpen(pack.id);
    });
    grip.addEventListener("pointerdown", (e) => {
      if (!reorderAllowed(search.value)) return;
      startRowDrag(e, item, pack.id, { list, drop: (id, position) => void reorder(id, position) });
    });
    return item;
  }

  /** A row was dropped on a new place: store the order, then show the list again. */
  async function reorder(packId: number, position: number): Promise<void> {
    say("");
    try {
      await reorderPack(packId, position);
    } catch (err) {
      say(errorMessage(err));
    }
    await reload();
  }

  // Reloads can overlap (a drop right after the list was shown): only the latest one paints, failures included.
  let loads = 0;

  /** The Library has no packs: the list's only line. */
  const emptyItem = el("li", { class: "pm-empty-item muted" }, "No packs yet. Create one to start.");
  /** The search matches nothing: the list's only line (its text follows the query). */
  const noMatchItem = el("li", { class: "pm-empty-item muted" });

  /**
   * Show the current search over the rows already drawn: hide the rows that do
   * not match, update the count and the list's state. Cheap, so typing never
   * rebuilds rows or drops the Previews caches.
   */
  function applyFilter(): void {
    const view = searchView(packs, search.value);
    if (view.filtering) cancelRowDrag();
    packCount.textContent = packCountText(packs.length, view.filtering ? view.shownIds.size : null);
    list.classList.toggle("filtering", view.filtering);
    for (const item of packRows(list)) {
      item.hidden = !view.shownIds.has(Number(item.dataset.id));
    }
    noMatchItem.textContent = noPackMatchText(search.value);
    noMatchItem.hidden = !view.noMatch;
  }

  /** Draw the loaded packs from scratch (their data changed), then apply the search (kept across reloads and shows). */
  function paint(): void {
    cancelRowDrag();
    for (const cache of previews) cache.clear();
    previews = [];
    emptyItem.hidden = packs.length > 0;
    list.replaceChildren(...packs.map(row), emptyItem, noMatchItem);
    applyFilter();
  }

  async function reload(): Promise<void> {
    const load = ++loads;
    try {
      const loaded = await listPackFacts();
      if (load !== loads) return;
      if (loadFailed) say(""); // a successful load clears an earlier load failure only
      packs = loaded;
      paint();
    } catch (err) {
      if (load !== loads) return;
      say(errorMessage(err), true);
    }
  }

  return {
    element,
    reload,
    showError: (text) => say(text),
    clearMessage: () => say(""),
  };
}

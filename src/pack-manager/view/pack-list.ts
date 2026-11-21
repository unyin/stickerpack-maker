// The pack list (SPEC §5): create, open, and delete packs, with Draft/Live
// badges. Reads the database only; no desync checks here (SPEC §4).
import { explorerLabel } from "../../icons";
import { el, errorMessage } from "../../ui";
import { deletePack, listPacks, revealPack, type PackSummary } from "../api";
import { packCountText, packDeleteMessage } from "../model/messages";
import { confirmChoice } from "../../dialog";
import { createPackDialog, statusBadge } from "./dialogs";

export function buildPackList(onOpen: (packId: number) => void): {
  element: HTMLElement;
  reload(): Promise<void>;
  /** Show an error in the list's message line. */
  showError(text: string): void;
} {
  const message = el("p", { class: "message", role: "alert" });
  const notice = el("p", { class: "pm-notice", role: "status" });
  const list = el("ul", { class: "pm-pack-list" });
  const newButton = el("button", { class: "primary", type: "button" }, "New pack…") as HTMLButtonElement;
  // How many packs the Library holds; sticker counts live in each pack's view (owner, 2026-11-21).
  const packCount = el("span", { class: "pm-pack-count" });
  const element = el(
    "section",
    { class: "view pm-list" },
    el("div", { class: "pm-list-head" }, el("div", { class: "pm-list-title" }, el("h1", {}, "Pack Manager"), packCount), newButton),
    el("p", { class: "muted" }, "Organise stickers into packs. Files are named in pack order, ready to drag into @Stickers."),
    message,
    notice,
    list,
  );

  newButton.addEventListener("click", async () => {
    const pack = await createPackDialog();
    if (pack) onOpen(pack.id);
  });

  async function remove(pack: PackSummary): Promise<void> {
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
    message.textContent = "";
    try {
      const leftover = await deletePack(pack.id);
      notice.textContent = leftover
        ? `“${pack.title}” is gone from the Library, but its folder could not be removed (${leftover.reason}). Delete ${leftover.path} yourself.`
        : `Deleted “${pack.title}”.`;
    } catch (err) {
      message.textContent = errorMessage(err);
    }
    await reload();
  }

  function row(pack: PackSummary): HTMLElement {
    const open = el("button", { class: "pm-pack-open", type: "button", title: "Open this pack" },
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
      message.textContent = "";
      revealPack(pack.id).catch((err) => (message.textContent = errorMessage(err)));
    });
    const del = el("button", { class: "secondary", type: "button", title: "Delete this pack" }, "Delete");
    del.addEventListener("click", () => void remove(pack));
    return el(
      "li",
      { class: "pm-pack-row" },
      open,
      statusBadge(pack.status),
      reveal,
      del,
    );
  }

  async function reload(): Promise<void> {
    try {
      const packs = await listPacks();
      message.textContent = ""; // a successful load clears an earlier failure
      packCount.textContent = packCountText(packs.length);
      list.replaceChildren(...packs.map(row));
      if (packs.length === 0) list.append(el("li", { class: "pm-empty-item muted" }, "No packs yet. Create one to start."));
    } catch (err) {
      message.textContent = errorMessage(err);
    }
  }

  return { element, reload, showError: (text) => void (message.textContent = text) };
}

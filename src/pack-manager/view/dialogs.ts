// The Pack Manager's dialogs (SPEC §5): create pack, sticker delete
// confirmations with previews, Send to pack, and the hard block for files
// that are not valid stickers.
import { el, errorMessage } from "../../ui";
import {
  createPack,
  isSendFailure,
  listPacks,
  sendToPack,
  suggestShortName,
  type Pack,
  type PackSummary,
  type SendReport,
  type StickerView,
} from "../api";
import { fileNameOf, matchesSearch, sendReportText, STICKER_RULE, statusLabel, stickerCountText } from "../model/messages";
import { confirmDialog, openDialog, type DialogHandle } from "./dialog";
import { previewImage, type Previews } from "./previews";

export function statusBadge(status: Pack["status"]): HTMLElement {
  return el("span", { class: `pm-badge pm-badge-${status}` }, statusLabel(status));
}

/**
 * Title and Short Name fields for a new pack: the Short Name previews the
 * auto-derived one until the user edits it (SPEC §5). `read()` gives the
 * Title and the Short Name to send (null = auto-derive).
 */
export function newPackFields(onEnter: () => void): {
  fields: HTMLElement;
  title: HTMLInputElement;
  read(): { title: string; shortName: string | null };
} {
  const title = el("input", { class: "pm-input", type: "text", maxlength: "64", "aria-label": "Title" }) as HTMLInputElement;
  const shortName = el("input", {
    class: "pm-input pm-mono",
    type: "text",
    maxlength: "64",
    spellcheck: "false",
    "aria-label": "Short Name",
  }) as HTMLInputElement;
  const hint = el("p", { class: "muted pm-hint" }, "Derived from the Title; you can edit it while the pack is Draft.");
  let edited = false;
  let request = 0;
  const preview = () => {
    if (edited) return;
    const mine = ++request;
    suggestShortName(title.value)
      .then((name) => {
        if (mine === request && !edited) shortName.value = name;
      })
      .catch(() => {});
  };
  title.addEventListener("input", preview);
  shortName.addEventListener("input", () => {
    edited = shortName.value.trim() !== "";
    hint.textContent = edited
      ? "Your Short Name: letters, digits and single underscores, starting with a letter. Clear it to derive it from the Title again."
      : "Derived from the Title; you can edit it while the pack is Draft.";
    if (!edited) preview();
  });
  for (const input of [title, shortName]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onEnter();
    });
  }
  preview();
  const fields = el(
    "div",
    { class: "pm-fields" },
    el("label", { class: "field-label" }, "Title", title),
    el("label", { class: "field-label" }, "Short Name", shortName),
    hint,
  );
  return { fields, title, read: () => ({ title: title.value, shortName: edited ? shortName.value.trim() : null }) };
}

/** Create a Draft pack (SPEC §5). Resolves with it, or null when cancelled. */
export async function createPackDialog(): Promise<Pack | null> {
  const message = el("p", { class: "message", role: "alert" });
  let created: Pack | null = null;
  let handle: DialogHandle<"create" | "cancel"> | null = null;
  const form = newPackFields(() => handle?.buttons.get("create")?.click());
  handle = openDialog<"create" | "cancel">(
    "New pack",
    [form.fields, el("p", { class: "muted" }, "New packs start as Draft."), message],
    [
      { label: "Cancel", value: "cancel" },
      {
        label: "Create",
        value: "create",
        variant: "primary",
        action: async () => {
          try {
            const { title, shortName } = form.read();
            created = await createPack(title, shortName);
            return true;
          } catch (err) {
            message.textContent = errorMessage(err);
            return false;
          }
        },
      },
    ],
    "cancel",
  );
  form.title.focus();
  return (await handle.result) === "create" ? created : null;
}

function stickerCard(sticker: StickerView, previews: Previews, large: boolean): HTMLElement {
  const image = sticker.missing
    ? el("div", { class: "pm-missing-art" }, "Missing")
    : previewImage(previews.sticker(sticker.id, sticker.format), `Sticker ${sticker.position}`, "pm-confirm-img");
  return el(
    "figure",
    { class: large ? "pm-confirm-card large" : "pm-confirm-card" },
    image,
    el(
      "figcaption",
      {},
      el("span", { class: "pm-pos" }, `#${sticker.position}`),
      " ",
      sticker.emojiString === "" ? el("span", { class: "muted" }, "no emoji") : el("span", { class: "pm-emoji" }, sticker.emojiString),
    ),
  );
}

/** Confirm a permanent sticker delete, showing the affected stickers (SPEC §5). */
export function confirmStickerDelete(stickers: readonly StickerView[], previews: Previews): Promise<boolean> {
  const single = stickers.length === 1;
  return confirmDialog(
    single ? `Delete sticker #${stickers[0].position}?` : `Delete ${stickers.length} stickers?`,
    [
      el("div", { class: single ? "pm-confirm-one" : "pm-confirm-grid" }, ...stickers.map((s) => stickerCard(s, previews, single))),
      el(
        "p",
        {},
        single
          ? "The sticker and its file are deleted permanently; the stickers after it move up."
          : "These stickers and their files are deleted permanently; the pack is renumbered to fill the gaps.",
      ),
    ],
    single ? "Delete sticker" : `Delete ${stickers.length} stickers`,
    true,
  );
}

/** Hard block for a file that is not a valid sticker (SPEC §5 replacement rules). */
export function invalidFileDialog(path: string, reason: string): Promise<"editor" | "cancel"> {
  return openDialog<"editor" | "cancel">(
    "Not a valid sticker",
    [
      el("p", {}, el("strong", {}, fileNameOf(path)), ` ${reason}.`),
      el("p", { class: "muted" }, `A sticker must be ${STICKER_RULE}. Open it in the Editor to make it one.`),
    ],
    [
      { label: "Cancel", value: "cancel" },
      { label: "Open in editor", value: "editor", variant: "primary" },
    ],
    "cancel",
  ).result;
}

/**
 * Send to pack (SPEC §5): searchable target list with badges, the current
 * pack excluded, inline New pack, and "Delete originals after sending"
 * (off = Duplicate, on = Move). Resolves with the report text, or null when
 * cancelled. Failures stay in the dialog with their per-file errors.
 */
export async function sendDialog(currentPackId: number, stickers: readonly StickerView[]): Promise<{
  report: SendReport;
  text: string;
} | null> {
  const message = el("div", { class: "message", role: "alert" });
  const search = el("input", { class: "pm-input", type: "search", placeholder: "Search packs", "aria-label": "Search packs" }) as HTMLInputElement;
  const list = el("ul", { class: "pm-target-list", role: "listbox", "aria-label": "Target pack" });
  const moveBox = el("input", { type: "checkbox" }) as HTMLInputElement;
  let packs: PackSummary[] = [];
  let target: PackSummary | Pack | null = null;
  let handle: DialogHandle<"send" | "cancel"> | null = null;

  const newPackArea = el("div", { class: "pm-new-pack" });
  const newPackButton = el("button", { class: "secondary", type: "button" }, "New pack…") as HTMLButtonElement;
  newPackButton.addEventListener("click", () => {
    newPackButton.hidden = true;
    const form = newPackFields(() => void createInline());
    const create = el("button", { class: "primary", type: "button" }, "Create and select") as HTMLButtonElement;
    const createInline = async () => {
      try {
        const { title, shortName } = form.read();
        const pack = await createPack(title, shortName);
        packs = [...packs, { ...pack, stickerCount: 0 }];
        target = pack;
        newPackArea.replaceChildren();
        newPackButton.hidden = false;
        newPackArea.append(newPackButton);
        renderList();
      } catch (err) {
        message.textContent = errorMessage(err);
      }
    };
    create.addEventListener("click", () => void createInline());
    newPackArea.replaceChildren(form.fields, el("div", { class: "actions" }, create));
    form.title.focus();
  });
  newPackArea.append(newPackButton);

  function renderList(): void {
    const shown = packs.filter((p) => p.id !== currentPackId && matchesSearch(p, search.value));
    list.replaceChildren(
      ...shown.map((p) => {
        const item = el(
          "li",
          { role: "option", tabindex: "0", "aria-selected": String(target?.id === p.id), class: target?.id === p.id ? "selected" : "" },
          el("span", { class: "pm-target-title" }, p.title),
          el("span", { class: "muted pm-mono" }, p.shortName),
          el("span", { class: "muted" }, stickerCountText(p.stickerCount)),
          statusBadge(p.status),
        );
        const choose = () => {
          target = p;
          renderList();
        };
        item.addEventListener("click", choose);
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            choose();
          }
        });
        return item;
      }),
    );
    if (shown.length === 0) list.append(el("li", { class: "muted pm-empty-item" }, packs.length <= 1 ? "No other packs yet: create one." : "No pack matches."));
    const send = handle?.buttons.get("send");
    if (send) send.disabled = target === null;
  }
  search.addEventListener("input", renderList);

  let sent: { report: SendReport; text: string } | null = null;
  const send = async (): Promise<boolean> => {
    const chosen = target;
    if (!chosen) return false;
    try {
      const report = await sendToPack(stickers.map((s) => s.id), chosen.id, moveBox.checked);
      sent = { report, text: sendReportText(report, chosen.title) };
      return true;
    } catch (err) {
      if (isSendFailure(err)) {
        message.replaceChildren(
          el("p", {}, err.message),
          ...(err.fileErrors.length
            ? [el("ul", {}, ...err.fileErrors.map((f) => el("li", {}, `${fileNameOf(f.path)}: ${f.reason}`)))]
            : []),
        );
      } else {
        message.textContent = errorMessage(err);
      }
      return false;
    }
  };
  handle = openDialog<"send" | "cancel">(
    stickers.length === 1 ? `Send sticker #${stickers[0].position} to pack` : `Send ${stickers.length} stickers to pack`,
    [
      search,
      list,
      newPackArea,
      el("label", { class: "pm-check" }, moveBox, " Delete originals after sending"),
      el(
        "p",
        { class: "muted pm-hint" },
        "Off: independent copies (Duplicate). On: the originals are deleted after every copy succeeded, and this pack is renumbered (Move). Copies go to the end of the target pack with their emoji.",
      ),
      message,
    ],
    [
      { label: "Cancel", value: "cancel" },
      { label: "Send", value: "send", variant: "primary", action: send },
    ],
    "cancel",
  );
  renderList();
  try {
    packs = await listPacks();
  } catch (err) {
    message.textContent = errorMessage(err);
  }
  renderList();
  search.focus();
  return (await handle.result) === "send" ? sent : null;
}

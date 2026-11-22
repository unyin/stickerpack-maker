// The Pack Manager's dialogs (SPEC §5): create pack, sticker delete
// confirmations with previews, Send to pack, and the hard block for files
// that are not valid stickers.
import { el, errorMessage, onActivate } from "../../ui";
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
import { rustTrim, shortNameProblem, titleProblem } from "../model/names";
import {
  fileNameOf,
  GO_LIVE_CONFIRMATION,
  matchesSearch,
  REVERT_TO_DRAFT_WARNING,
  sendReportText,
  statusLabel,
  STICKER_RULE,
  stickerCountText,
} from "../model/messages";
import { confirmChoice, openDialog, type DialogHandle } from "../../dialog";
import { previewImage, type Previews } from "./previews";

export function statusBadge(status: Pack["status"]): HTMLElement {
  return el("span", { class: `pm-badge pm-badge-${status}` }, statusLabel(status));
}

/**
 * Title and Short Name fields for a new pack: the Short Name previews the
 * auto-derived one until the user edits it (SPEC §5). `read()` gives the
 * Title and the Short Name to send (null = auto-derive). `problem()` is why
 * the form cannot be submitted (null = fine); `onChange` fires on every edit.
 */
export function newPackFields(onEnter: () => void, onChange: () => void = () => {}): {
  fields: HTMLElement;
  title: HTMLInputElement;
  problem(): string | null;
  read(): { title: string; shortName: string | null };
} {
  const title = el("input", { class: "pm-input", type: "text", "aria-label": "Title" }) as HTMLInputElement;
  const shortName = el("input", {
    class: "pm-input pm-mono",
    type: "text",
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
  title.addEventListener("input", onChange);
  shortName.addEventListener("input", onChange);
  shortName.addEventListener("input", () => {
    edited = rustTrim(shortName.value) !== "";
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
  const problem = () => titleProblem(title.value) ?? shortNameProblem(shortName.value);
  return { fields, title, problem, read: () => ({ title: title.value, shortName: edited ? rustTrim(shortName.value) : null }) };
}

/** Create a Draft pack (SPEC §5). Resolves with it, or null when cancelled. */
export async function createPackDialog(): Promise<Pack | null> {
  const message = el("p", { class: "message", role: "alert" });
  let created: Pack | null = null;
  let handle: DialogHandle<"create" | "cancel"> | null = null;
  const syncCreate = () => {
    const create = handle?.buttons.get("create");
    if (!create) return;
    const why = form.problem();
    create.disabled = why !== null;
    create.title = why ?? "";
    message.textContent = rustTrim(form.title.value) === "" ? "" : (why ?? "");
  };
  const form = newPackFields(() => handle?.buttons.get("create")?.click(), syncCreate);
  handle = openDialog<"create" | "cancel">(
    "New pack",
    [form.fields, el("p", { class: "muted" }, "New packs start as Draft."), message],
    [
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
      { label: "Cancel", value: "cancel" },
    ],
    "cancel",
  );
  syncCreate();
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
  return confirmChoice(
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
    { actionLabel: single ? "Delete sticker" : `Delete ${stickers.length} stickers`, keepLabel: "Cancel", danger: true },
  );
}

/** Draft→Live confirmation: "Go Live?" with Go Live / Keep Draft (default). */
export function confirmGoLive(): Promise<boolean> {
  return confirmChoice("Go Live?", [el("p", {}, GO_LIVE_CONFIRMATION)], { actionLabel: "Go Live", keepLabel: "Keep Draft" });
}

/** Live→Draft warning: "Revert to Draft?" with Make Draft / Keep Live (default). */
export function confirmRevertToDraft(): Promise<boolean> {
  return confirmChoice("Revert to Draft?", [el("p", {}, REVERT_TO_DRAFT_WARNING)], { actionLabel: "Make Draft", keepLabel: "Keep Live" });
}

/** What a sticker's Edit button does next (owner decision 2026-11-21). */
export type EditChoice = "edit" | "replace" | "cancel";

/**
 * Edit asks first: open the sticker in the Editor, run the Replace flow
 * (pick a file for this slot, no Editor), or cancel. Cancel is the safe
 * choice: focused and primary, and what Esc chooses (SPEC §2 conventions).
 */
export function editChoiceDialog(position: number): Promise<EditChoice> {
  return openDialog<EditChoice>(
    `Edit sticker #${position}?`,
    [
      el("p", {}, "Edit opens this sticker in the Editor."),
      el("p", {}, "Replace puts another image file in this slot, keeping its position and emoji."),
    ],
    [
      { label: "Edit", value: "edit" },
      { label: "Replace…", value: "replace" },
      { label: "Cancel", value: "cancel", variant: "primary" },
    ],
    "cancel",
    { defaultChoice: "cancel" },
  ).result;
}

/** Hard block for a file that is not a valid sticker (SPEC §5 replacement rules). Resolves true to open it in the Editor. */
export function invalidFileDialog(path: string, reason: string): Promise<boolean> {
  return confirmChoice(
    "Not a valid sticker",
    [
      el("p", {}, el("strong", {}, fileNameOf(path)), ` ${reason}.`),
      el("p", { class: "muted" }, `A sticker must be ${STICKER_RULE}. Open it in the Editor to make it one.`),
    ],
    { actionLabel: "Open in editor", keepLabel: "Cancel" },
  );
}

/** A pack the picker can choose: listed, or just created inline. */
export type PickedPack = PackSummary | Pack;

export interface PackPicker {
  /** The search field, the list and the inline New pack area, in order. */
  readonly elements: HTMLElement[];
  /** The chosen pack, or null. */
  selected(): PickedPack | null;
  /** Load the packs (errors go to the message line), then render. */
  load(): Promise<void>;
  focus(): void;
}

/**
 * The target-pack picker of Send to pack and the Editor's save dialog
 * (SPEC §5-6): a searchable list with Draft/Live badges and an inline
 * **New pack…** (Title → auto Short Name, Draft) that selects the new pack.
 * `excludeId` hides a pack (Send's current one); `preselect` chooses one
 * when it is listed; `onChange` fires whenever the choice changes.
 */
export function packPicker(options: {
  message: HTMLElement;
  excludeId?: number;
  preselect?: number | null;
  onChange: () => void;
}): PackPicker {
  const { message, excludeId, onChange } = options;
  const search = el("input", { class: "pm-input", type: "search", placeholder: "Search packs", "aria-label": "Search packs" }) as HTMLInputElement;
  const list = el("ul", { class: "pm-target-list", role: "listbox", "aria-label": "Target pack" });
  let packs: PackSummary[] = [];
  let target: PickedPack | null = null;

  const choose = (p: PickedPack | null) => {
    target = p;
    renderList();
    onChange();
  };

  const newPackArea = el("div", { class: "pm-new-pack" });
  const newPackButton = el("button", { class: "secondary", type: "button" }, "New pack…") as HTMLButtonElement;
  newPackButton.addEventListener("click", () => {
    newPackButton.hidden = true;
    const sync = () => {
      const why = form.problem();
      create.disabled = why !== null;
      create.title = why ?? "";
    };
    const form = newPackFields(() => void createInline(), sync);
    const create = el("button", { class: "primary", type: "button" }, "Create and select") as HTMLButtonElement;
    const createInline = async () => {
      if (form.problem()) return;
      try {
        const { title, shortName } = form.read();
        const pack = await createPack(title, shortName);
        packs = [...packs, { ...pack, stickerCount: 0 }];
        newPackArea.replaceChildren();
        newPackButton.hidden = false;
        newPackArea.append(newPackButton);
        choose(pack);
      } catch (err) {
        message.textContent = errorMessage(err);
      }
    };
    create.addEventListener("click", () => void createInline());
    newPackArea.replaceChildren(form.fields, el("div", { class: "actions" }, create));
    sync();
    form.title.focus();
  });
  newPackArea.append(newPackButton);

  function renderList(): void {
    const shown = packs.filter((p) => p.id !== excludeId && matchesSearch(p, search.value));
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
        item.addEventListener("click", () => choose(p));
        onActivate(item, () => choose(p));
        return item;
      }),
    );
    const others = packs.filter((p) => p.id !== excludeId).length;
    if (shown.length === 0) list.append(el("li", { class: "muted pm-empty-item" }, others === 0 ? emptyText(excludeId) : "No pack matches."));
  }
  search.addEventListener("input", renderList);

  return {
    elements: [search, list, newPackArea],
    selected: () => target,
    async load() {
      renderList();
      try {
        packs = await listPacks();
      } catch (err) {
        message.textContent = errorMessage(err);
      }
      const preselected = packs.find((p) => p.id === options.preselect && p.id !== excludeId);
      if (preselected && target === null) choose(preselected);
      else renderList();
    },
    focus: () => search.focus(),
  };
}

function emptyText(excludeId: number | undefined): string {
  return excludeId === undefined ? "No packs yet: create one." : "No other packs yet: create one.";
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
  const moveBox = el("input", { type: "checkbox" }) as HTMLInputElement;
  let handle: DialogHandle<"send" | "cancel"> | null = null;
  const picker = packPicker({
    message,
    excludeId: currentPackId,
    onChange: () => syncSend(),
  });
  // Disabled controls show their reason (SPEC §2).
  function syncSend(): void {
    const send = handle?.buttons.get("send");
    if (!send) return;
    send.disabled = picker.selected() === null;
    send.title = send.disabled ? "Choose a pack to send to" : "";
  }

  let sent: { report: SendReport; text: string } | null = null;
  const send = async (): Promise<boolean> => {
    const chosen = picker.selected();
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
      ...picker.elements,
      el("label", { class: "pm-check" }, moveBox, " Delete originals after sending"),
      el(
        "p",
        { class: "muted pm-hint" },
        "Off: independent copies (Duplicate). On: the originals are deleted after every copy succeeded, and this pack is renumbered (Move). Copies go to the end of the target pack with their emoji.",
      ),
      message,
    ],
    [
      { label: "Send", value: "send", variant: "primary", action: send },
      { label: "Cancel", value: "cancel" },
    ],
    "cancel",
  );
  syncSend();
  await picker.load();
  picker.focus();
  return (await handle.result) === "send" ? sent : null;
}

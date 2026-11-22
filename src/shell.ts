import type { AppState } from "./api";
import { clear, el } from "./ui";
import { forgetEditorOrigin, openFileInEditor, renderEditor } from "./views/editor";
import type { StickerOrigin } from "./editor/save";
import { forgetPackManager, renderPackManager } from "./views/pack-manager";
import { resetPackMemory } from "./pack-manager/model/pack-memory";
import { renderSettings } from "./views/settings";

type ViewId = "editor" | "pack-manager" | "settings";

const NAV: Array<{ id: ViewId; label: string }> = [
  { id: "editor", label: "Editor" },
  { id: "pack-manager", label: "Pack Manager" },
  { id: "settings", label: "Settings" },
];

/** App shell: top navigation between the two tools plus Settings. */
export function renderShell(
  container: HTMLElement,
  state: AppState,
  onChanged: () => void,
): void {
  clear(container);

  const nav = el("nav", { class: "nav" });
  const content = el("main", { class: "content" });

  function show(view: ViewId): void {
    for (const btn of Array.from(nav.children)) {
      btn.classList.toggle(
        "active",
        (btn as HTMLElement).dataset.view === view,
      );
    }
    clear(content);
    if (view === "editor") content.append(renderEditor());
    else if (view === "pack-manager") content.append(renderPackManager(state.libraryPath, { openInEditor }));
    else
      renderSettings(content, state, () => {
        forgetPackManager(); // a new Library may sit at the same path
        resetPackMemory(); // pack pickers must not start on a pack of the old one
        forgetEditorOrigin(); // nor may a save replace a sticker id of the old one
        onChanged();
      });
  }

  /** Pack Manager -> Editor: the Editor asks about unsaved changes, then switches tabs and opens the file. */
  function openInEditor(path: string, origin?: StickerOrigin): void {
    void openFileInEditor(path, () => show("editor"), origin);
  }

  for (const item of NAV) {
    const btn = el(
      "button",
      { class: "nav-btn", "data-view": item.id },
      item.label,
    );
    btn.addEventListener("click", () => show(item.id));
    nav.append(btn);
  }

  const header = el(
    "header",
    { class: "topbar" },
    el("span", { class: "brand" }, "Stickerpack Maker"),
    nav,
  );

  container.append(header);
  if (state.libraryStatus === "invalid") {
    container.append(
      el(
        "div",
        { class: "banner", role: "alert" },
        el("strong", {}, "Library problem. "),
        state.libraryError ?? "The configured Library is not usable.",
        " Open Settings to re-point at an intact Library or create a fresh one.",
      ),
    );
  }
  container.append(content);

  // A broken Library lands the user on Settings; otherwise start in the Editor.
  show(state.libraryStatus === "invalid" ? "settings" : "editor");
}
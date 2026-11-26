import type { AppState } from "./api";
import { icon, type IconName } from "./icons";
import { clear, el } from "./ui";
import { forgetEditorOrigin, openFileInEditor, openThumbnailFileInEditor, renderEditor, setEditorNav } from "./views/editor";
import type { StickerOrigin } from "./shared/sticker-origin";
import type { ThumbnailOrigin } from "./shared/thumbnail-origin";
import {
  forgetPackManager,
  onPackManagerState,
  packManagerState,
  renderPackManager,
  revealStickerOnShow,
  revealThumbnailOnShow,
  showPackList,
} from "./views/pack-manager";
import { dialogOpen } from "./dialog";
import { backButtonState, BACK_TO_LIST_TITLE, mouseBackGoesToList, packTabLabel, tabClickAction, type PackManagerState, type ViewId } from "./shell-model";
import { resetPackMemory } from "./pack-manager/model/pack-memory";
import { renderSettings } from "./views/settings";

const TABS: Array<{ id: ViewId; label: string; icon: IconName }> = [
  { id: "editor", label: "Editor", icon: "scissors" },
  { id: "pack-manager", label: "Pack Manager", icon: "layers" },
  { id: "settings", label: "Settings", icon: "cog" },
];

let removeMouseBack: (() => void) | null = null;

/**
 * App shell (SPEC §5 "Top bar"): a reserved back slot, the Editor and Pack
 * Manager tabs, the app name pushed right, and the Settings tab in the corner.
 * Nothing in the bar moves between states: the back button only toggles
 * visibility, and the Pack Manager tab's pack name is width-capped.
 */
export function renderShell(
  container: HTMLElement,
  state: AppState,
  onChanged: () => void,
): void {
  clear(container);

  const nav = el("nav", { class: "nav" });
  const content = el("main", { class: "content" });
  const tabs = new Map<ViewId, HTMLButtonElement>();
  const backButton = el("button", { class: "secondary tb-back", type: "button", title: BACK_TO_LIST_TITLE }, "← Pack list") as HTMLButtonElement;
  let screen: ViewId = "editor";
  let pm: PackManagerState = packManagerState();

  /** Bring the tabs and the back button in line with the screen and the open pack. */
  function refreshChrome(): void {
    for (const [id, btn] of tabs) btn.classList.toggle("active", id === screen);
    const tab = packTabLabel(screen, pm.open);
    const pmTab = tabs.get("pack-manager")!;
    pmTab.replaceChildren(
      icon("layers"),
      tab.label,
      ...(tab.packTitle === null
        ? []
        : [el("span", { class: "tab-sep", "aria-hidden": "true" }, "›"), el("span", { class: "tab-pack" }, tab.packTitle)]),
    );
    pmTab.title = tab.tooltip ?? "";
    const back = backButtonState(screen, pm);
    backButton.classList.toggle("tb-hidden", !back.visible);
    backButton.disabled = back.disabled;
  }

  onPackManagerState((next) => {
    pm = next;
    refreshChrome();
  });

  function show(view: ViewId): void {
    screen = view;
    refreshChrome();
    clear(content);
    if (view === "editor") content.append(renderEditor());
    else if (view === "pack-manager")
      content.append(renderPackManager(state.libraryPath, { openInEditor, openThumbnailInEditor }));
    else
      renderSettings(content, state, () => {
        forgetPackManager(); // a new Library may sit at the same path
        resetPackMemory(); // pack pickers must not start on a pack of the old one
        forgetEditorOrigin(); // nor may a save replace a sticker id of the old one
        onChanged();
      });
    // The Pack Manager's build may have reported a pack just now: sync once more.
    refreshChrome();
  }

  // Editor -> Pack Manager: the saved note's links show the sticker or the
  // pack's thumbnail slot there (SPM-10, SPM-12).
  setEditorNav({
    showSticker: (packId, stickerId) => {
      revealStickerOnShow(packId, stickerId);
      show("pack-manager");
    },
    showThumbnail: (packId) => {
      revealThumbnailOnShow(packId);
      show("pack-manager");
    },
  });

  /** Pack Manager -> Editor: the Editor asks about unsaved changes, then switches tabs and opens the file. */
  function openInEditor(path: string, origin?: StickerOrigin): void {
    void openFileInEditor(path, () => show("editor"), origin);
  }

  /** Pack Manager -> Editor: the thumbnail slot's Create/Replace opens Thumbnail mode. */
  function openThumbnailInEditor(path: string, origin: ThumbnailOrigin): void {
    void openThumbnailFileInEditor(path, () => show("editor"), origin);
  }

  for (const item of TABS) {
    const btn = el("button", { class: "nav-btn", "data-view": item.id }, icon(item.icon), item.label) as HTMLButtonElement;
    btn.addEventListener("click", () => {
      const action = tabClickAction(item.id, screen, pm);
      if (action === "list") showPackList();
      else if (action === "show") show(item.id);
    });
    tabs.set(item.id, btn);
    if (item.id !== "settings") nav.append(btn);
  }
  backButton.addEventListener("click", showPackList);

  // The mouse's back button (button 3) does what the back button does, only where that button is usable.
  // The app has no history, so the press is swallowed everywhere: WebView2 must not navigate on it.
  const onMouseBack = (e: MouseEvent): void => {
    if (e.button !== 3) return;
    e.preventDefault();
    if (e.type === "mouseup" && !dialogOpen() && mouseBackGoesToList(e.button, screen, pm)) showPackList();
  };
  removeMouseBack?.(); // the shell is rebuilt on a Library change: one listener pair only
  window.addEventListener("mousedown", onMouseBack);
  window.addEventListener("mouseup", onMouseBack);
  removeMouseBack = () => {
    window.removeEventListener("mousedown", onMouseBack);
    window.removeEventListener("mouseup", onMouseBack);
  };

  const header = el(
    "header",
    { class: "topbar" },
    el("span", { class: "tb-slot" }, backButton),
    nav,
    el("span", { class: "brand" }, "Stickerpack Maker"),
    tabs.get("settings")!,
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
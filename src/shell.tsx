import { createRef, useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { AppState } from "./api";
import type { IconName } from "./icons";
import { Icon } from "./react/Icon";
import { mountDomView, mountShell, mountView, unmountViews } from "./react/mount";
import { navigate, setNavigator } from "./react/navigation";
import { forgetEditorOrigin, openFileInEditor, openThumbnailFileInEditor, renderEditor, setEditorNav } from "./views/editor";
import type { StickerOrigin } from "./shared/sticker-origin";
import type { ThumbnailOrigin } from "./shared/thumbnail-origin";
import {
  forgetPackManager,
  setPackManagerListener,
  packManagerState,
  renderPackManager,
  revealStickerOnShow,
  revealThumbnailOnShow,
  showPackList,
} from "./views/pack-manager";
import { backButtonState, BACK_TO_LIST_TITLE, packTabLabel, tabClickAction, type ViewId } from "./shell-model";
import type { PackManagerState } from "./pack-manager/model/shell-state";
import { resetPackMemory } from "./pack-manager/model/pack-memory";
import { SettingsView } from "./views/settings";

const TABS: Array<{ id: ViewId; label: string; icon: IconName }> = [
  { id: "editor", label: "Editor", icon: "scissors" },
  { id: "pack-manager", label: "Pack Manager", icon: "layers" },
  { id: "settings", label: "Settings", icon: "cog" },
];

/** A broken Library lands the user on Settings; otherwise start in the Editor. */
function initialScreen(state: AppState): ViewId {
  return state.libraryStatus === "invalid" ? "settings" : "editor";
}

// The Pack Manager state as an external store: a thin adapter over
// setPackManagerListener, which has no unset API. The unsubscribe restores a
// no-op only if this subscription's listener is still the registered one.
// Mirrors the "unregister only while still ours" guard of setNavigator in react/navigation.ts.
let installedPmListener: (() => void) | null = null;
function subscribePackManager(onChange: () => void): () => void {
  const listener = (): void => onChange();
  installedPmListener = listener;
  setPackManagerListener(listener);
  return () => {
    if (installedPmListener !== listener) return;
    installedPmListener = null;
    setPackManagerListener(() => {});
  };
}

/**
 * App shell (SPEC §5 "Top bar"): a reserved back slot, the Editor and Pack
 * Manager tabs, the app name pushed right, and the Settings tab in the corner.
 * Nothing in the bar moves between states: the back button only toggles
 * visibility, and the Pack Manager tab's pack name is width-capped.
 *
 * The content leaf (`<main className="content">`) has no JSX children, ever:
 * the mount registry is the only writer of its contents, and views mount only
 * from `show()` / `renderShell`, outside React, never from an effect.
 */
function Shell({
  state,
  contentRef,
  mountScreen,
}: {
  state: AppState;
  contentRef: RefObject<HTMLElement | null>;
  mountScreen: (view: ViewId) => void;
}) {
  const [screen, setScreen] = useState<ViewId>(() => initialScreen(state));
  const pm: PackManagerState = useSyncExternalStore(subscribePackManager, packManagerState);

  /**
   * The one navigation handler; called only from event handlers and the
   * navigator, never from render or an effect. Runs outside React: the view
   * roots die before the state change, the flushSync commits the chrome so the
   * content leaf is current, then the next view mounts into it.
   */
  function show(view: ViewId): void {
    unmountViews();
    flushSync(() => setScreen(view));
    mountScreen(view);
  }

  // Registration only: the cleanup unregisters, it mounts and unmounts nothing.
  useEffect(() => {
    const unregister = setNavigator(show);
    // Editor -> Pack Manager: the saved note's links show the sticker or the
    // pack's thumbnail slot there (SPM-10, SPM-12). Routed through navigate so
    // closures registered by an earlier boot stay safe.
    setEditorNav({
      showSticker: (packId, stickerId) => {
        revealStickerOnShow(packId, stickerId);
        navigate("pack-manager");
      },
      showThumbnail: (packId) => {
        revealThumbnailOnShow(packId);
        navigate("pack-manager");
      },
    });
    return unregister;
    // Runs once: show only uses stable setters and the mountScreen prop.
  }, []);

  const tab = packTabLabel(screen, pm.open);
  const back = backButtonState(screen, pm);

  function tabButton(item: (typeof TABS)[number]) {
    const isPackTab = item.id === "pack-manager";
    return (
      <button
        key={item.id}
        className={item.id === screen ? "nav-btn active" : "nav-btn"}
        data-view={item.id}
        title={isPackTab ? tab.tooltip || undefined : undefined}
        onClick={() => {
          const action = tabClickAction(item.id, screen, pm);
          if (action === "list") showPackList();
          else if (action === "show") show(item.id);
        }}
      >
        <Icon name={item.icon} />
        {item.label}
        {isPackTab && tab.packTitle !== null ? (
          <>
            <span className="tab-sep" aria-hidden="true">›</span>
            <span className="tab-pack">{tab.packTitle}</span>
          </>
        ) : null}
      </button>
    );
  }

  return (
    <>
      <header className="topbar">
        <span className="tb-slot">
          <button
            className={back.visible ? "secondary tb-back" : "secondary tb-back tb-hidden"}
            type="button"
            title={BACK_TO_LIST_TITLE}
            disabled={back.disabled}
            onClick={showPackList}
          >
            ← Pack list
          </button>
        </span>
        <nav className="nav">{TABS.filter((t) => t.id !== "settings").map(tabButton)}</nav>
        <span className="brand">Stickerpack Maker</span>
        {tabButton(TABS.find((t) => t.id === "settings")!)}
      </header>
      {state.libraryStatus === "invalid" ? (
        <div className="banner" role="alert">
          <strong>Library problem. </strong>
          {state.libraryError ?? "The configured Library is not usable."}
          {" Open Settings to re-point at an intact Library or create a fresh one."}
        </div>
      ) : null}
      <main className="content" ref={contentRef} />
    </>
  );
}

export function renderShell(
  container: HTMLElement,
  state: AppState,
  onChanged: () => void,
): void {
  const contentRef = createRef<HTMLElement>();

  const onLibraryChanged = (): void => {
    forgetPackManager(); // a new Library may sit at the same path
    resetPackMemory(); // pack pickers must not start on a pack of the old one
    forgetEditorOrigin(); // nor may a save replace a sticker id of the old one
    onChanged();
  };

  /** Pack Manager -> Editor: the Editor asks about unsaved changes, then switches tabs and opens the file. */
  const openInEditor = (path: string, origin?: StickerOrigin): void => {
    void openFileInEditor(path, () => navigate("editor"), origin);
  };

  /** Pack Manager -> Editor: the thumbnail slot's Create/Replace opens Thumbnail mode. */
  const openThumbnailInEditor = (path: string, origin: ThumbnailOrigin): void => {
    void openThumbnailFileInEditor(path, () => navigate("editor"), origin);
  };

  /** The one place a screen maps to its registry call; mounts into the content leaf. */
  function mountScreen(view: ViewId): void {
    const content = contentRef.current!;
    if (view === "editor") mountDomView(content, "editor", renderEditor());
    else if (view === "pack-manager")
      mountDomView(content, "pack-manager", renderPackManager(state.libraryPath, { openInEditor, openThumbnailInEditor }));
    else mountView(content, "settings", <SettingsView state={state} onLibraryChanged={onLibraryChanged} />);
  }

  mountShell(container, <Shell state={state} contentRef={contentRef} mountScreen={mountScreen} />);
  mountScreen(initialScreen(state));
}

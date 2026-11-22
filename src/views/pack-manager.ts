// The Pack Manager (SPEC §5): the pack list, or one open pack. Built once
// per Library and reused, so an open pack survives switching tabs; showing
// the tab again re-reads the pack list, or the open pack (the Editor may have
// saved into it), but never re-scans an open pack for Missing files (desync
// checks run on pack open and Refresh only, SPEC §4).
import "../pack-manager/pack-manager.css";
import { el, errorMessage } from "../ui";
import { packMemory } from "../pack-manager/model/pack-memory";
import { buildPackList } from "../pack-manager/view/pack-list";
import { buildPackView, type PackViewHandle } from "../pack-manager/view/pack-view";

export interface PackManagerNav {
  /** Show the Editor with this image open. */
  openInEditor(path: string): void;
}

let cached: { library: string | null; root: HTMLElement; shown(): void; dispose(): void } | null = null;

export function renderPackManager(library: string | null, nav: PackManagerNav): HTMLElement {
  // Only a built Pack Manager can be stale (a first build must keep the Editor's last-saved pack).
  if (cached && cached.library !== library) forgetPackManager();
  cached ??= build(library, nav);
  cached.shown();
  return cached.root;
}

/**
 * Drop the cached Pack Manager. Settings calls this whenever it creates or
 * re-points a Library: a new Library in the SAME folder keeps the path, so
 * the path alone cannot tell the cache it is stale (an open pack or an error
 * from the old Library would otherwise stay on screen).
 */
export function forgetPackManager(): void {
  cached?.dispose();
  cached = null;
  packMemory.lastSavedPackId = null; // an id from the previous Library
}

function build(library: string | null, nav: PackManagerNav): NonNullable<typeof cached> {
  const root = el("div", { class: "pm" });
  const list = buildPackList((id) => void openPack(id));
  let pack: PackViewHandle | null = null;

  function showList(): void {
    pack?.destroy();
    pack = null;
    packMemory.openPackId = null;
    root.replaceChildren(list.element);
    void list.reload();
  }

  async function openPack(packId: number): Promise<void> {
    try {
      const handle = await buildPackView(packId, { back: showList, openInEditor: nav.openInEditor });
      pack?.destroy();
      pack = handle;
      packMemory.openPackId = packId; // pack pickers start on it
      root.replaceChildren(handle.element);
    } catch (err) {
      showList();
      list.showError(`Cannot open the pack: ${errorMessage(err)}`);
    }
  }

  root.replaceChildren(list.element);
  return {
    library,
    root,
    shown: () => {
      // The Editor may have saved into a pack meanwhile (SPM-10).
      if (pack) pack.reload();
      else void list.reload();
    },
    dispose: () => {
      pack?.destroy();
      pack = null;
      packMemory.openPackId = null;
    },
  };
}

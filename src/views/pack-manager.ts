// The Pack Manager (SPEC §5): the pack list, or one open pack. Built once
// per Library and reused, so an open pack survives switching tabs; showing
// the tab again re-reads the pack list but never re-scans an open pack
// (desync checks run on pack open and Refresh only, SPEC §4).
import "../pack-manager/pack-manager.css";
import { el, errorMessage } from "../ui";
import { buildPackList } from "../pack-manager/view/pack-list";
import { buildPackView, type PackViewHandle } from "../pack-manager/view/pack-view";

export interface PackManagerNav {
  /** Show the Editor with this image open. */
  openInEditor(path: string): void;
}

let cached: { library: string | null; root: HTMLElement; shown(): void } | null = null;

export function renderPackManager(library: string | null, nav: PackManagerNav): HTMLElement {
  if (cached?.library !== library) cached = build(library, nav);
  cached.shown();
  return cached.root;
}

function build(library: string | null, nav: PackManagerNav): NonNullable<typeof cached> {
  const root = el("div", { class: "pm" });
  const list = buildPackList((id) => void openPack(id));
  let pack: PackViewHandle | null = null;

  function showList(): void {
    pack?.destroy();
    pack = null;
    root.replaceChildren(list.element);
    void list.reload();
  }

  async function openPack(packId: number): Promise<void> {
    try {
      const handle = await buildPackView(packId, { back: showList, openInEditor: nav.openInEditor });
      pack?.destroy();
      pack = handle;
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
      if (!pack) void list.reload();
    },
  };
}

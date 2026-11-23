// The Pack Manager (SPEC §5): the pack list, or one open pack. Built once
// per Library and reused, so an open pack survives switching tabs; showing
// the tab again re-reads the pack list, or the open pack (the Editor may have
// saved into it), but never re-scans an open pack for Missing files (desync
// checks run on pack open and Refresh only, SPEC §4).
import "../pack-manager/pack-manager.css";
import { el, errorMessage } from "../ui";
import { packMemory } from "../pack-manager/model/pack-memory";
import type { StickerOrigin } from "../shared/sticker-origin";
import { buildPackList } from "../pack-manager/view/pack-list";
import { buildPackView, type PackViewHandle } from "../pack-manager/view/pack-view";

export interface PackManagerNav {
  /** Show the Editor with this image open; `origin` when it is a pack's sticker (Edit). */
  openInEditor(path: string, origin?: StickerOrigin): void;
}

let cached: { library: string | null; root: HTMLElement; shown(): void; dispose(): void } | null = null;

/** A sticker to show the next time the Pack Manager is shown (the Editor's saved-note link). */
let pendingReveal: { packId: number; stickerId: number } | null = null;

/**
 * Show sticker `stickerId` of pack `packId` when the Pack Manager is next
 * shown (SPM-10): the shell sets this, then shows the Pack Manager, which
 * opens the pack (unless open) and selects the sticker instead of only
 * re-reading what is open.
 */
export function revealStickerOnShow(packId: number, stickerId: number): void {
  pendingReveal = { packId, stickerId };
}

export function renderPackManager(library: string | null, nav: PackManagerNav): HTMLElement {
  if (cached?.library !== library) forgetPackManager();
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
}

function build(library: string | null, nav: PackManagerNav): NonNullable<typeof cached> {
  const root = el("div", { class: "pm" });
  const list = buildPackList((id) => void openPack(id));
  let pack: PackViewHandle | null = null;
  let openId: number | null = null;

  function showList(): void {
    pack?.destroy();
    pack = null;
    openId = null;
    packMemory.openPackId = null;
    root.replaceChildren(list.element);
    void list.reload();
  }

  async function openPack(packId: number): Promise<boolean> {
    try {
      const handle = await buildPackView(packId, { back: showList, openInEditor: nav.openInEditor });
      pack?.destroy();
      pack = handle;
      openId = packId;
      packMemory.openPackId = packId; // pack pickers start on it
      root.replaceChildren(handle.element);
      return true;
    } catch (err) {
      showList();
      list.showError(`Cannot open the pack: ${errorMessage(err)}`);
      return false;
    }
  }

  /** Open pack `packId` unless it is open, then select sticker `stickerId` there. */
  async function showSticker(packId: number, stickerId: number): Promise<void> {
    if (openId === packId && pack) pack.reveal(stickerId, false);
    else if (await openPack(packId)) pack?.reveal(stickerId, true);
  }

  root.replaceChildren(list.element);
  return {
    library,
    root,
    shown: () => {
      const reveal = pendingReveal;
      pendingReveal = null;
      if (reveal) void showSticker(reveal.packId, reveal.stickerId);
      // The Editor may have saved into a pack meanwhile (SPM-10).
      else if (pack) pack.reload();
      else void list.reload();
    },
    dispose: () => {
      pack?.destroy();
      pack = null;
      openId = null;
      packMemory.openPackId = null;
    },
  };
}

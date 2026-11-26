// The Pack Manager (SPEC §5): the pack list, or one open pack. Built once
// per Library and reused, so an open pack survives switching tabs; showing
// the tab again re-reads the pack list, or the open pack (the Editor may have
// saved into it), but never re-scans an open pack for Missing files (desync
// checks run on pack open, Refresh and each show of the Pack list, SPEC §4).
import "../pack-manager/pack-manager.css";
import { el, errorMessage } from "../ui";
import { packMemory } from "../pack-manager/model/pack-memory";
import type { StickerOrigin } from "../shared/sticker-origin";
import type { ThumbnailOrigin } from "../shared/thumbnail-origin";
import { buildPackList } from "../pack-manager/view/pack-list";
import { buildPackView, type PackViewHandle } from "../pack-manager/view/pack-view";
import { changed, NO_PACK_MANAGER, type PackManagerState } from "../pack-manager/model/shell-state";

export interface PackManagerNav {
  /** Show the Editor with this image open; `origin` when it is a pack's sticker (Edit). */
  openInEditor(path: string, origin?: StickerOrigin): void;
  /** Show the Editor's Thumbnail mode with this image open; the pack's thumbnail session. */
  openThumbnailInEditor(path: string, origin: ThumbnailOrigin): void;
}

let cached: { library: string | null; root: HTMLElement; shown(): void; showList(): void; dispose(): void } | null = null;

/**
 * Which pack is open and whether it is busy, for the top bar (SPM-26): the
 * Pack Manager reports every change here and the shell listens, so the shell
 * never reaches into the Pack Manager's internals. `forgetPackManager` reports
 * "no pack" like closing the pack does.
 */
let state: PackManagerState = NO_PACK_MANAGER;
let listener: ((state: PackManagerState) => void) | null = null;

/** Publish on change only: a report that repeats the state is dropped. */
function publish(next: PackManagerState): void {
  if (!changed(state, next)) return;
  state = next;
  listener?.(state);
}

/** Sets the one listener; a new one replaces the previous (the shell sets it on each render, so a rebuilt shell never leaves a stale one). */
export function setPackManagerListener(next: (state: PackManagerState) => void): void {
  listener = next;
}

/** The current state, for a subscriber that starts after the Pack Manager did. */
export function packManagerState(): PackManagerState {
  return state;
}

/** The top bar's back button and the Pack Manager tab: show the Pack list. */
export function showPackList(): void {
  cached?.showList();
}

/**
 * What the Pack Manager shows the next time it is shown (the Editor's
 * saved-note links): a sticker, or `stickerId` null for the thumbnail slot.
 */
let pendingReveal: { packId: number; stickerId: number | null } | null = null;

/**
 * Show sticker `stickerId` of pack `packId` when the Pack Manager is next
 * shown (SPM-10): the shell sets this, then shows the Pack Manager, which
 * opens the pack (unless open) and selects the sticker instead of only
 * re-reading what is open.
 */
export function revealStickerOnShow(packId: number, stickerId: number): void {
  pendingReveal = { packId, stickerId };
}

/** Show the pack's thumbnail slot when the Pack Manager is next shown (SPM-12). */
export function revealThumbnailOnShow(packId: number): void {
  pendingReveal = { packId, stickerId: null };
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
  let disposed = false;
  // Whatever the user asked for last (another pack, the list, a reveal in the open pack) supersedes an open still loading.
  let opening = 0;

  function showList(): void {
    opening++;
    pack?.destroy();
    pack = null;
    openId = null;
    packMemory.openPackId = null;
    publish(NO_PACK_MANAGER);
    root.replaceChildren(list.element);
    list.clearMessage(); // each show starts clear; openPack's showError comes after
    void list.reload();
  }

  async function openPack(packId: number): Promise<boolean> {
    const mine = ++opening;
    try {
      let handleRef: PackViewHandle | null = null;
      let latest = { title: "", busy: false }; // the view's reports, including its first, made before it has a handle
      const handle = await buildPackView(packId, {
        report: (title, busy) => {
          latest = { title, busy };
          // A report counts only from the handle that is the open pack: never one still opening, a destroyed one, or none open.
          if (handleRef !== null && handleRef === pack) publish({ open: { id: packId, title }, busy });
        },
        openInEditor: nav.openInEditor,
        openThumbnailInEditor: nav.openThumbnailInEditor,
      });
      if (disposed || mine !== opening) {
        // This open no longer counts: the Library changed (publishing would put the old Library's pack on the rebuilt shell),
        // or a later click superseded it (the last pack asked for wins).
        handle.destroy();
        return false;
      }
      pack?.destroy();
      pack = handle;
      handleRef = handle;
      openId = packId;
      packMemory.openPackId = packId; // pack pickers start on it
      publish({ open: { id: packId, title: latest.title }, busy: latest.busy });
      root.replaceChildren(handle.element);
      return true;
    } catch (err) {
      if (disposed || mine !== opening) return false; // same reason: a failure nobody waits for stays silent
      showList();
      list.showError(`Cannot open the pack: ${errorMessage(err)}`);
      return false;
    }
  }

  /** Open pack `packId` unless it is open, then select sticker `stickerId` there (null: the thumbnail slot). */
  async function showSticker(packId: number, stickerId: number | null): Promise<void> {
    if (openId === packId && pack) {
      opening++;
      pack.reveal(stickerId, false);
    } else if (await openPack(packId)) pack?.reveal(stickerId, true);
  }

  root.replaceChildren(list.element);
  return {
    library,
    root,
    showList,
    shown: () => {
      const reveal = pendingReveal;
      pendingReveal = null;
      if (reveal) void showSticker(reveal.packId, reveal.stickerId);
      // The Editor may have saved into a pack meanwhile (SPM-10).
      else if (pack) pack.reload();
      else {
        list.clearMessage();
        void list.reload();
      }
    },
    dispose: () => {
      disposed = true;
      pack?.destroy();
      pack = null;
      openId = null;
      packMemory.openPackId = null;
      publish(NO_PACK_MANAGER);
    },
  };
}

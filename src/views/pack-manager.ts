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
import { NO_PACK_MANAGER, type PackManagerState } from "../shell-model";

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

function publish(next: PackManagerState): void {
  state = next;
  listener?.(state);
}

/** The shell's one subscription (it re-renders on a Library change, so a new one replaces the old). */
export function onPackManagerState(next: ((state: PackManagerState) => void) | null): void {
  listener = next;
}

/** The current state, for a subscriber that starts after the Pack Manager did. */
export function packManagerState(): PackManagerState {
  return state;
}

/** The top bar's back button, the Pack Manager tab and the mouse back button: show the Pack list. */
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

  /** Tell the shell what is open: the pack's Title and busy state as the pack view last reported them. */
  function report(title: string, busy: boolean): void {
    if (openId !== null) publish({ open: { id: openId, title }, busy });
  }

  function showList(): void {
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
    try {
      let handleRef: PackViewHandle | null = null;
      const handle = await buildPackView(packId, {
        report: (title, busy) => {
          // Only the pack on screen reports: not one still opening, nor a destroyed one finishing.
          if (handleRef === pack) report(title, busy);
        },
        openInEditor: nav.openInEditor,
        openThumbnailInEditor: nav.openThumbnailInEditor,
      });
      pack?.destroy();
      pack = handle;
      handleRef = handle;
      openId = packId;
      packMemory.openPackId = packId; // pack pickers start on it
      publish({ open: { id: packId, title: handle.title() }, busy: false });
      root.replaceChildren(handle.element);
      return true;
    } catch (err) {
      showList();
      list.showError(`Cannot open the pack: ${errorMessage(err)}`);
      return false;
    }
  }

  /** Open pack `packId` unless it is open, then select sticker `stickerId` there (null: the thumbnail slot). */
  async function showSticker(packId: number, stickerId: number | null): Promise<void> {
    if (openId === packId && pack) pack.reveal(stickerId, false);
    else if (await openPack(packId)) pack?.reveal(stickerId, true);
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
      pack?.destroy();
      pack = null;
      openId = null;
      packMemory.openPackId = null;
      publish(NO_PACK_MANAGER);
    },
  };
}

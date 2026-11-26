// The top bar's pure decisions (SPEC §5 "Top bar", SPM-26): what the Pack
// Manager tab says, what clicking it does, and when the back button shows.
// shell.ts wires them to the DOM.

import type { OpenPack, PackManagerState } from "./pack-manager/model/shell-state";

export type ViewId = "editor" | "pack-manager" | "settings";

export const BACK_TO_LIST_TITLE = "Back to the list of packs";

/** What varies on the Pack Manager tab (its icon and label come from the shell's TABS): the open pack's Title after a separator, and the tooltip. */
export interface PackTabLabel {
  /** The open pack's Title, shown after a "›" separator, or null. */
  packTitle: string | null;
  tooltip: string | null;
}

export function packTabLabel(screen: ViewId, open: OpenPack | null): PackTabLabel {
  if (!open) return { packTitle: null, tooltip: null };
  return {
    packTitle: open.title,
    tooltip: screen === "pack-manager" ? BACK_TO_LIST_TITLE : `Back to “${open.title}”`,
  };
}

/** What a click on a tab does: show its screen, go to the Pack list, or nothing (the pack view is busy). */
export type TabAction = "show" | "list" | "none";

export function tabClickAction(target: ViewId, screen: ViewId, state: PackManagerState): TabAction {
  if (target === "pack-manager" && screen === "pack-manager" && state.open) return state.busy ? "none" : "list";
  return "show";
}

/** The top-bar back button: visible only while the Pack Manager shows a pack; disabled while that pack is busy. */
export function backButtonState(screen: ViewId, state: PackManagerState): { visible: boolean; disabled: boolean } {
  const visible = screen === "pack-manager" && state.open !== null;
  return { visible, disabled: visible && state.busy };
}

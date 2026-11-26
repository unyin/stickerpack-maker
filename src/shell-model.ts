// The top bar's pure decisions (SPEC §5 "Top bar", SPM-26): what the Pack
// Manager tab says, what clicking it does, and when the back button shows.
// shell.ts wires them to the DOM.

export type ViewId = "editor" | "pack-manager" | "settings";

/** The pack open in the Pack Manager's pack view (what the shell needs of it). */
export interface OpenPack {
  id: number;
  title: string;
}

/** What the Pack Manager tells the shell: the open pack (null on the Pack list) and whether it is busy. */
export interface PackManagerState {
  open: OpenPack | null;
  busy: boolean;
}

export const NO_PACK_MANAGER: PackManagerState = { open: null, busy: false };

export const BACK_TO_LIST_TITLE = "Back to the list of packs";

/** The Pack Manager tab: "Pack Manager", then (a pack open) a separator and the pack's Title; plus its tooltip. */
export interface PackTabLabel {
  label: string;
  /** The open pack's Title, shown after a "›" separator, or null. */
  packTitle: string | null;
  tooltip: string | null;
}

export function packTabLabel(screen: ViewId, open: OpenPack | null): PackTabLabel {
  if (!open) return { label: "Pack Manager", packTitle: null, tooltip: null };
  return {
    label: "Pack Manager",
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

/** The mouse's back button (MouseEvent.button 3) returns to the Pack list, only where the back button is usable. */
export function mouseBackGoesToList(button: number, screen: ViewId, state: PackManagerState): boolean {
  if (button !== 3) return false;
  const back = backButtonState(screen, state);
  return back.visible && !back.disabled;
}

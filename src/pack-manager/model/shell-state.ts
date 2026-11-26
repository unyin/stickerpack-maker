// What the Pack Manager publishes to the top bar (SPM-26); the shell only reads it.

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

/** Whether `next` differs from `prev` in anything the shell shows: the open pack's id or Title, or busy. */
export function changed(prev: PackManagerState, next: PackManagerState): boolean {
  return prev.open?.id !== next.open?.id || prev.open?.title !== next.open?.title || prev.busy !== next.busy;
}

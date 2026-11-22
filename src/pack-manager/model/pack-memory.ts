// Which pack a pack picker starts on (owner decision 2026-11-22): the pack
// open in the Pack Manager, else the last pack the Editor saved into this
// session, else none. Both last only until the app closes.

/** The packs the picker's default comes from, most wanted first. */
export interface PackMemory {
  /** The pack open in the Pack Manager's pack view, or null on the pack list. */
  openPackId: number | null;
  /** The pack the Editor last saved into this session. */
  lastSavedPackId: number | null;
}

/** The app's one memory, set by the Pack Manager and the Editor. */
export const packMemory: PackMemory = { openPackId: null, lastSavedPackId: null };

/** Forget both: the Library changed, so their ids belong to another one. */
export function resetPackMemory(): void {
  packMemory.openPackId = null;
  packMemory.lastSavedPackId = null;
}

/**
 * The pack a picker starts on: the first remembered pack that it lists
 * (Send to pack does not list the pack it sends from), else null.
 */
export function defaultPackId(listed: readonly number[], memory: PackMemory): number | null {
  for (const id of [memory.openPackId, memory.lastSavedPackId]) {
    if (id !== null && listed.includes(id)) return id;
  }
  return null;
}

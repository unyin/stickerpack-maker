// Undo/redo over immutable states (ADR-0005). States share unchanged pixel
// buffers, so the memory budget counts each buffer once, and only buffers
// the present state does not use: the cost of being able to go back.
//
// Every step carries the label of the action that produced it IN-BAND
// (SPM-15): the Actions panel lists them, and a parallel label array could
// desync from the states it describes. The budget drops whole entries, so a
// dropped step takes its label with it.
import { IMPORT_MAX_SIDE } from "./image";

export interface HistoryOptions<S> {
  /** Maximum bytes of buffers kept alive only by undo/redo steps. */
  budgetBytes: number;
  /** The pixel buffers a state holds (shared buffers are counted once). */
  buffersOf: (state: S) => Iterable<ArrayBufferLike>;
}

/** One state and the label of the action that produced it (null: the session's start). */
interface Entry<S> {
  readonly state: S;
  readonly label: string | null;
}

/**
 * The Actions panel's read-only list (SPEC §6 Layout, SPM-15): one label per
 * state, oldest first, with the present's position marked. A clickable jump
 * is a planned later promotion, deliberately not built.
 */
export interface ActionTrail {
  /** Labels oldest first; null is the session's start (no action produced it). */
  readonly labels: readonly (string | null)[];
  /** Index of the present state in `labels`; later labels are redoable steps. */
  readonly currentIndex: number;
}

/** Undo steps the default budget holds when each repaints a whole layer at the import cap. */
const DEFAULT_FULL_REPAINTS = 32;

/** Default budget: room for 32 full repaints of an RGBA8 layer at the import cap (square). */
export const DEFAULT_HISTORY_BUDGET = DEFAULT_FULL_REPAINTS * IMPORT_MAX_SIDE * IMPORT_MAX_SIDE * 4;

export class History<S> {
  private past: Entry<S>[] = [];
  private future: Entry<S>[] = [];
  private current: Entry<S>;
  private saved: S;

  constructor(
    initial: S,
    private readonly options: HistoryOptions<S>,
  ) {
    this.current = { state: initial, label: null };
    this.saved = initial;
  }

  get present(): S {
    return this.current.state;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Unsaved changes: the present is not the state last imported or saved. */
  get isDirty(): boolean {
    return this.current.state !== this.saved;
  }

  /** Make `next` the present as one undoable step labelled `label`; clears redo. */
  commit(label: string, next: S): void {
    this.past.push(this.current);
    this.current = { state: next, label };
    this.future = [];
    this.enforceBudget();
  }

  undo(): void {
    const previous = this.past.pop();
    if (previous === undefined) return;
    this.future.push(this.current);
    this.current = previous;
  }

  redo(): void {
    const next = this.future.pop();
    if (next === undefined) return;
    this.past.push(this.current);
    this.current = next;
  }

  /** The present was just saved: it becomes the clean state. */
  markSaved(): void {
    this.saved = this.current.state;
  }

  /**
   * The action labels for the Actions panel (SPM-15): the whole trail,
   * oldest first, including the steps redo can still reach.
   */
  actionTrail(): ActionTrail {
    const ordered = [...this.past, this.current, ...[...this.future].reverse()];
    return { labels: ordered.map((entry) => entry.label), currentIndex: this.past.length };
  }

  /** Bytes of buffers held only by undo/redo steps. */
  get retainedBytes(): number {
    const live = new Set(this.options.buffersOf(this.current.state));
    const retained = new Set<ArrayBufferLike>();
    for (const entry of [...this.past, ...this.future]) {
      for (const buffer of this.options.buffersOf(entry.state)) {
        if (!live.has(buffer)) retained.add(buffer);
      }
    }
    let bytes = 0;
    for (const buffer of retained) bytes += buffer.byteLength;
    return bytes;
  }

  /** Drop the oldest undo steps until the retained bytes fit the budget. */
  private enforceBudget(): void {
    while (this.past.length > 0 && this.retainedBytes > this.options.budgetBytes) {
      this.past.shift();
    }
  }
}

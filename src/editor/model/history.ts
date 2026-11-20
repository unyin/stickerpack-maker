// Undo/redo over immutable states (ADR-0005). States share unchanged pixel
// buffers, so the memory budget counts each buffer once, and only buffers
// the present state does not use: the cost of being able to go back.
import { IMPORT_MAX_SIDE } from "./image";

export interface HistoryOptions<S> {
  /** Maximum bytes of buffers kept alive only by undo/redo steps. */
  budgetBytes: number;
  /** The pixel buffers a state holds (shared buffers are counted once). */
  buffersOf: (state: S) => Iterable<ArrayBufferLike>;
}

/** Undo steps the default budget holds when each repaints a whole layer at the import cap. */
const DEFAULT_FULL_REPAINTS = 32;

/** Default budget: room for 32 full repaints of an RGBA8 layer at the import cap (square). */
export const DEFAULT_HISTORY_BUDGET = DEFAULT_FULL_REPAINTS * IMPORT_MAX_SIDE * IMPORT_MAX_SIDE * 4;

export class History<S> {
  private past: S[] = [];
  private future: S[] = [];
  private current: S;
  private saved: S;

  constructor(
    initial: S,
    private readonly options: HistoryOptions<S>,
  ) {
    this.current = initial;
    this.saved = initial;
  }

  get present(): S {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Unsaved changes: the present is not the state last imported or saved. */
  get isDirty(): boolean {
    return this.current !== this.saved;
  }

  /** Make `next` the present as one undoable step; clears redo. */
  commit(next: S): void {
    this.past.push(this.current);
    this.current = next;
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
    this.saved = this.current;
  }

  /** Bytes of buffers held only by undo/redo steps. */
  get retainedBytes(): number {
    const live = new Set(this.options.buffersOf(this.current));
    const retained = new Set<ArrayBufferLike>();
    for (const state of [...this.past, ...this.future]) {
      for (const buffer of this.options.buffersOf(state)) {
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

// One editing session: the document history, the layer selection, the cut
// selection with its own step trail, and change notifications for the view.
// No selection is an undo step of the document (ADR-0005); undo/redo prunes
// the layer selection to layers that still exist.
import { layerImage, layerIndex, textLayersOf, type Doc, type TextLayer } from "./document";
import { DEFAULT_HISTORY_BUDGET, History, type ActionTrail } from "./history";
import type { Region } from "./region";

/** The selection's step states, oldest first, with the current state's position (EditorSession.selectionTrail). */
export interface SelectionTrail {
  readonly states: readonly (Region | null)[];
  readonly currentIndex: number;
}

/** Pixel buffers of a document (text renderings and restore sources too), for the history's memory budget. */
function buffersOf(doc: Doc): ArrayBufferLike[] {
  return doc.layers.flatMap((l) => {
    const buffers = [layerImage(l).pixels.buffer];
    if (l.kind === "raster" && l.restoreSource) buffers.push(l.restoreSource.pixels.buffer);
    return buffers;
  });
}

export type SelectMode = "replace" | "toggle";

export class EditorSession {
  private readonly history: History<Doc>;
  private selected: string[] = [];
  private selectedRegion: Region | null = null;
  /** The selection's own step trail (SPM-23): the states it came through, oldest first. */
  private readonly regionPast: (Region | null)[] = [];
  /** The states the selection was stepped back over, newest last: its redo trail. */
  private readonly regionFuture: (Region | null)[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(doc: Doc, budgetBytes = DEFAULT_HISTORY_BUDGET) {
    this.history = new History(doc, { budgetBytes, buffersOf });
  }

  get doc(): Doc {
    return this.history.present;
  }

  /** The selected text layers, bottom to top. */
  get selectedTexts(): TextLayer[] {
    return textLayersOf(this.doc, this.selected);
  }

  /** Selected layer ids, in the order they were selected. */
  get selection(): readonly string[] {
    return this.selected;
  }

  /** The cut selection drawn on the canvas, or null (SPM-9). Not an undo step of the document. */
  get region(): Region | null {
    return this.selectedRegion;
  }

  /**
   * Commit a selection change as ONE step of the selection's own trail
   * (SPM-23): the state it replaces joins the past, the stepped-over future
   * is dropped, and the new state becomes the selection. Committing the
   * state already drawn changes nothing (no step).
   */
  commitRegion(region: Region | null): void {
    if (region === this.selectedRegion) return;
    this.regionPast.push(this.selectedRegion);
    this.regionFuture.length = 0;
    this.selectedRegion = region;
    this.notify();
  }

  /**
   * Replace the selection WITHOUT a new step (SPM-23): the wand press's
   * tolerance refills amend the step the press began, so one drag stays one
   * step. The amended state diverges from any stepped-over future, which is
   * therefore dropped.
   */
  amendRegion(region: Region | null): void {
    if (region === this.selectedRegion) return;
    this.regionFuture.length = 0;
    this.selectedRegion = region;
    this.notify();
  }

  /**
   * Clear the selection and its whole trail (SPM-23): Esc's path, and the
   * Cut/Delete paths that use the selection up. The selection was stepped
   * through to build it, so it cannot be stepped back to once it is consumed.
   */
  clearRegion(): void {
    if (this.selectedRegion === null && this.regionPast.length === 0 && this.regionFuture.length === 0) return;
    this.selectedRegion = null;
    this.clearRegionTrail();
    this.notify();
  }

  /** Whether the selection can be stepped back (its own trail has a state). */
  get canUndoRegion(): boolean {
    return this.regionPast.length > 0;
  }

  /** Whether a stepped-back selection state can be stepped forward to again. */
  get canRedoRegion(): boolean {
    return this.regionFuture.length > 0;
  }

  /** Step the selection back one committed change (the redo trail keeps the state left behind). */
  undoRegion(): void {
    const previous = this.regionPast.pop();
    if (previous === undefined) return;
    this.regionFuture.push(this.selectedRegion);
    this.selectedRegion = previous;
    this.notify();
  }

  /** Step the selection forward one change, when it was stepped back. */
  redoRegion(): void {
    const next = this.regionFuture.pop();
    if (next === undefined) return;
    this.regionPast.push(this.selectedRegion);
    this.selectedRegion = next;
    this.notify();
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  /**
   * The document's action labels for the Actions panel (SPEC §6 Layout,
   * SPM-15): oldest first, the present's position marked, redoable steps
   * included. Read-only; the selection's own trail is not part of it (the
   * panel derives those entries from the Region states themselves).
   */
  actionTrail(): ActionTrail {
    return this.history.actionTrail();
  }

  /**
   * The selection's step states for the Actions panel (SPM-15), oldest
   * first, with the current state's position. Read-only, like actionTrail:
   * each Region state carries its own contributions, so the panel derives
   * every step's label from the states themselves.
   */
  selectionTrail(): SelectionTrail {
    return { states: [...this.regionPast, this.selectedRegion], currentIndex: this.regionPast.length };
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /** Whether Undo has anything to do at all: a selection step or a document step (SPM-23). */
  get canUndoAny(): boolean {
    return this.canUndoRegion || this.canUndo;
  }

  /** Whether Redo has anything to do at all: a selection step or a document step (SPM-23). */
  get canRedoAny(): boolean {
    return this.canRedoRegion || this.canRedo;
  }

  /**
   * Ctrl+Z and the toolbar's Undo (SPM-23): step the selection back while its
   * own steps exist, and only then undo the document — which drops whatever
   * selection remains (the lifetime rule below).
   */
  undoSelectionFirst(): void {
    if (this.canUndoRegion) this.undoRegion();
    else this.undo();
  }

  /** Ctrl+Y / Ctrl+Shift+Z and the toolbar's Redo: the selection's steps first, then the document (SPM-23). */
  redoSelectionFirst(): void {
    if (this.canRedoRegion) this.redoRegion();
    else this.redo();
  }

  /** Unsaved changes, for the close warning (SPEC §6, wired in SPM-10). */
  get isDirty(): boolean {
    return this.history.isDirty;
  }

  /** Apply one operation as an undoable step, labelled for the Actions panel (SPM-15). A throwing operation changes nothing. */
  apply(label: string, operation: (doc: Doc) => Doc): void {
    const next = operation(this.doc);
    if (next === this.doc) return;
    this.history.commit(label, next);
    this.dropFloatingRegion();
    // A document EDIT clears the selection's step trail whatever remains of it
    // (owner, 2026-11-24: "Esc should clear it all, as should document
    // edits"): Ctrl+Z after an edit is a document undo, never a selection step.
    this.clearRegionTrail();
    this.pruneSelection();
    this.notify();
  }

  undo(): void {
    if (!this.history.canUndo) return;
    this.history.undo();
    this.dropFloatingRegion();
    this.pruneSelection();
    this.notify();
  }

  redo(): void {
    if (!this.history.canRedo) return;
    this.history.redo();
    this.dropFloatingRegion();
    this.pruneSelection();
    this.notify();
  }

  markSaved(): void {
    this.history.markSaved();
    this.notify();
  }

  /** Select a layer: "replace" makes it the only selection, "toggle" adds or removes it. */
  select(id: string, mode: SelectMode = "replace"): void {
    layerIndex(this.doc, id); // throws when the layer does not exist
    if (mode === "replace") this.selected = [id];
    else if (this.selected.includes(id)) this.selected = this.selected.filter((s) => s !== id);
    else this.selected = [...this.selected, id];
    this.notify();
  }

  clearSelection(): void {
    if (this.selected.length === 0) return;
    this.selected = [];
    this.notify();
  }

  /** Listen for any change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private pruneSelection(): void {
    const ids = new Set(this.doc.layers.map((l) => l.id));
    this.selected = this.selected.filter((id) => ids.has(id));
  }

  /**
   * A composed region is a floating area built from wand fills (each bound
   * to its layer's pixels) and polygons (SPM-23), so any document change
   * drops it, and a change that removes the selection takes its whole step
   * trail with it (the owner's undo clause). A plain rect or lasso region is
   * unanchored geometry and survives such a change (SPM-22's wand rule,
   * generalized); an EDIT still clears its trail in apply(), since edits
   * clear it all, while an undo/redo that leaves the region alone keeps it.
   */
  private dropFloatingRegion(): void {
    if (this.selectedRegion?.kind !== "compose") return;
    this.selectedRegion = null;
    this.clearRegionTrail();
  }

  private clearRegionTrail(): void {
    this.regionPast.length = 0;
    this.regionFuture.length = 0;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

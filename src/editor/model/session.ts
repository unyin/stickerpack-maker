// One editing session: the document history, the layer selection, and
// change notifications for the view. Selection is NOT an undo step
// (ADR-0005); undo/redo prunes it to layers that still exist.
import { layerImage, layerIndex, textLayersOf, type Doc, type TextLayer } from "./document";
import { DEFAULT_HISTORY_BUDGET, History } from "./history";
import type { Region } from "./region";

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

  /** The cut selection drawn on the canvas, or null (SPM-9). Not an undo step. */
  get region(): Region | null {
    return this.selectedRegion;
  }

  /** Set or clear the cut selection. */
  setRegion(region: Region | null): void {
    if (region === this.selectedRegion) return;
    this.selectedRegion = region;
    this.notify();
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /** Unsaved changes, for the close warning (SPEC §6, wired in SPM-10). */
  get isDirty(): boolean {
    return this.history.isDirty;
  }

  /** Apply one operation as an undoable step. A throwing operation changes nothing. */
  apply(operation: (doc: Doc) => Doc): void {
    const next = operation(this.doc);
    if (next === this.doc) return;
    this.history.commit(next);
    this.dropWandRegion();
    this.pruneSelection();
    this.notify();
  }

  undo(): void {
    if (!this.history.canUndo) return;
    this.history.undo();
    this.dropWandRegion();
    this.pruneSelection();
    this.notify();
  }

  redo(): void {
    if (!this.history.canRedo) return;
    this.history.redo();
    this.dropWandRegion();
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
   * A wand region is bound to its target layer's pixels (its mask lives in
   * that grid), so any document change drops it; rect and lasso regions
   * are plain geometry and survive (SPM-22).
   */
  private dropWandRegion(): void {
    if (this.selectedRegion?.kind === "wand") this.selectedRegion = null;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

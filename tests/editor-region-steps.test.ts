// The selection's own step trail (SPM-23, owner decisions 2026-11-24): its
// semantics in the session, and the route Ctrl+Z/Ctrl+Y and the toolbar's
// Undo/Redo share — the selection's steps first, then the document. The
// selection still never enters the document's history (ADR-0005).
import { expect, test } from "bun:test";
import type { RgbaImage } from "../src/editor/model/image";
import { startCanvas, STICKER } from "../src/editor/model/constraints";
import { newDocument, setLayerImage } from "../src/editor/model/document";
import { EditorSession } from "../src/editor/model/session";
import { rectRegion, type ComposedRegion, type PolygonRegion } from "../src/editor/model/region";

function image(width: number, height: number): RgbaImage {
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
}

/** The canvas a Sticker-mode session starts with. */
const STICKER_CANVAS = startCanvas(STICKER);

function rect(x0: number, y0: number, x1: number, y1: number): PolygonRegion {
  return rectRegion({ x: x0, y: y0 }, { x: x1, y: y1 })!;
}

/** A one-polygon floating selection, as a Shift/Rectangle composition stores it. */
function composed(points: PolygonRegion): ComposedRegion {
  return { kind: "compose", contributions: [{ kind: "poly", op: "add", feather: true, points: points.points }], outlines: [points.points] };
}

function session(): EditorSession {
  return new EditorSession(newDocument(image(4, 4), "base", STICKER_CANVAS));
}

test("a committed selection change is one step; an amendment replaces that step", () => {
  const s = session();
  const a = rect(0, 0, 2, 2);
  const b = rect(1, 1, 3, 3);
  expect(s.canUndoRegion).toBe(false);
  s.commitRegion(a);
  expect(s.region).toBe(a);
  expect(s.canUndoRegion).toBe(true);
  // A tolerance refill amends the step its press began: one step per drag.
  s.amendRegion(b);
  expect(s.region).toBe(b);
  expect(s.canUndoRegion).toBe(true);
  s.undoRegion();
  expect(s.region).toBeNull(); // the whole drag went back at once
  expect(s.canUndoRegion).toBe(false);
});

test("the trail steps back and forward; a new commit drops the stepped-over future", () => {
  const s = session();
  const a = rect(0, 0, 2, 2);
  const b = rect(1, 1, 3, 3);
  s.commitRegion(a);
  s.commitRegion(b);
  s.undoRegion();
  expect(s.region).toBe(a);
  expect(s.canRedoRegion).toBe(true);
  // Stepping back again keeps the redo trail (partial removals never clear it).
  s.undoRegion();
  expect(s.region).toBeNull();
  expect(s.canUndoRegion).toBe(false);
  expect(s.canRedoRegion).toBe(true);
  s.redoRegion();
  expect(s.region).toBe(a);
  s.redoRegion();
  expect(s.region).toBe(b);
  expect(s.canRedoRegion).toBe(false);
  // A new change diverges from the stepped-over states: the future goes.
  s.undoRegion();
  s.commitRegion(rect(2, 2, 4, 4));
  expect(s.canRedoRegion).toBe(false);
  // An amended state diverges too (a refill after a step-back mid-drag).
  s.undoRegion();
  s.amendRegion(b);
  expect(s.region).toBe(b);
  expect(s.canRedoRegion).toBe(false);
});

test("a plain replace is a step: stepping back restores the region it replaced", () => {
  const s = session();
  const first = composed(rect(0, 0, 2, 2));
  const second = rect(1, 1, 3, 3);
  s.commitRegion(first);
  s.commitRegion(second);
  s.undoRegion();
  expect(s.region).toBe(first);
});

test("the selection's steps never enter the document history", () => {
  const s = session();
  s.commitRegion(rect(0, 0, 2, 2));
  s.commitRegion(composed(rect(1, 1, 3, 3)));
  expect(s.canUndo).toBe(false);
  expect(s.isDirty).toBe(false);
  const doc = s.doc;
  s.undoRegion();
  expect(s.doc).toBe(doc);
});

test("Ctrl+Z steps the selection first, then falls through to the document", () => {
  const s = session();
  const base = s.doc.layers[0].id;
  const a = rect(0, 0, 2, 2);
  s.apply((doc) => setLayerImage(doc, base, image(4, 4)));
  const changed = s.doc;
  s.commitRegion(a);
  expect(s.canUndoAny).toBe(true);
  s.undoSelectionFirst();
  expect(s.region).toBeNull();
  expect(s.canUndoRegion).toBe(false);
  // The selection's steps are exhausted: the SAME key (and button) undoes the document.
  s.undoSelectionFirst();
  expect(s.doc).not.toBe(changed);
  expect(s.canRedoAny).toBe(true);
  // Ctrl+Y / Ctrl+Shift+Z mirror it: the selection's stepped-back state comes
  // back first (its redo trail), then the document's own redo runs.
  s.redoSelectionFirst();
  expect(s.region).toBe(a);
  s.redoSelectionFirst();
  expect(s.doc).toBe(changed);
});

test("the buttons' enablement follows either history: a selection step or a document step", () => {
  const s = session();
  expect(s.canUndoAny).toBe(false);
  expect(s.canRedoAny).toBe(false);
  s.commitRegion(rect(0, 0, 2, 2));
  expect(s.canUndoAny).toBe(true); // only a selection step
  expect(s.canRedoAny).toBe(false);
  s.undoRegion();
  expect(s.canUndoAny).toBe(false);
  expect(s.canRedoAny).toBe(true); // only a stepped-back selection state
  s.redoRegion();
  s.apply((doc) => setLayerImage(doc, s.doc.layers[0].id, image(4, 4)));
  expect(s.canUndoAny).toBe(true);
  // The edit cleared the selection's trail: only the document has steps left.
  expect(s.canUndoRegion).toBe(false);
  expect(s.canRedoRegion).toBe(false);
  // Both histories still live at once: a selection step after the edit, then a
  // document undo that leaves the plain selection alone.
  s.commitRegion(rect(1, 1, 3, 3));
  s.undo();
  expect(s.canUndoAny).toBe(true); // the selection's step
  expect(s.canRedoAny).toBe(true); // the document step
});

test("Esc and a consume clear the selection with its whole trail", () => {
  const s = session();
  s.commitRegion(rect(0, 0, 2, 2));
  s.commitRegion(rect(1, 1, 3, 3));
  s.clearRegion();
  expect(s.region).toBeNull();
  expect(s.canUndoRegion).toBe(false);
  expect(s.canRedoRegion).toBe(false);
  expect(s.canUndoAny).toBe(false);
  // A stepped-back future goes with it (Esc is not a selection step).
  s.commitRegion(rect(0, 0, 2, 2));
  s.undoRegion();
  s.clearRegion();
  expect(s.canRedoRegion).toBe(false);
});

test("a document edit drops a floating selection with its trail; a plain one survives it, trailless", () => {
  const s = session();
  const base = s.doc.layers[0].id;
  const plan = rect(0, 0, 2, 2);
  s.commitRegion(plan);
  s.commitRegion(composed(rect(1, 1, 3, 3)));
  s.apply((doc) => setLayerImage(doc, base, image(4, 4)));
  expect(s.region).toBeNull();
  expect(s.canUndoRegion).toBe(false);
  expect(s.canRedoRegion).toBe(false);
  // A plain Rectangle/Lasso survives an edit, but the edit clears its trail.
  s.commitRegion(plan);
  s.apply((doc) => setLayerImage(doc, base, image(4, 4)));
  expect(s.region).toBe(plan);
  expect(s.canUndoRegion).toBe(false);
  expect(s.canRedoRegion).toBe(false);
});

test("a document edit clears a surviving plain selection's trail: Ctrl+Z then undoes the document", () => {
  const s = session();
  const base = s.doc.layers[0].id;
  const plan = rect(0, 0, 2, 2);
  s.commitRegion(plan);
  s.apply((doc) => setLayerImage(doc, base, image(4, 4)));
  const changed = s.doc;
  expect(s.region).toBe(plan);
  expect(s.canUndoRegion).toBe(false);
  // Ctrl+Z is a document undo, never a step back through the pre-edit selection.
  s.undoSelectionFirst();
  expect(s.doc).not.toBe(changed);
  expect(s.region).toBe(plan);
});

test("a document edit kills stepped-back selection states even with no selection drawn", () => {
  const s = session();
  const base = s.doc.layers[0].id;
  s.commitRegion(rect(0, 0, 2, 2));
  s.undoRegion();
  expect(s.region).toBeNull();
  expect(s.canRedoRegion).toBe(true);
  s.apply((doc) => setLayerImage(doc, base, image(4, 4)));
  expect(s.region).toBeNull();
  expect(s.canUndoRegion).toBe(false);
  // Ctrl+Y cannot resurrect a pre-edit selection state.
  expect(s.canRedoRegion).toBe(false);
});

test("a document undo that leaves the selection alone keeps its trail", () => {
  const s = session();
  const base = s.doc.layers[0].id;
  s.apply((doc) => setLayerImage(doc, base, image(4, 4)));
  const plan = rect(0, 0, 2, 2);
  const next = rect(1, 1, 3, 3);
  s.commitRegion(plan);
  s.commitRegion(next);
  s.undo(); // a document undo; the plain selection itself is untouched
  expect(s.region).toBe(next);
  expect(s.canUndoRegion).toBe(true);
  s.undoRegion();
  expect(s.region).toBe(plan);
});

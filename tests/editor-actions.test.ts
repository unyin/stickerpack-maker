// The Actions tab's read-only list (SPEC §6 Layout, SPM-15 D3): the document
// trail oldest first with the present marked and the session's start labelled,
// and the selection's steps (SPM-23) nested under one Select entry after the
// last document action — derived from the Region states the session holds.
import { expect, test } from "bun:test";
import type { RgbaImage } from "../src/editor/model/image";
import { startCanvas, STICKER } from "../src/editor/model/constraints";
import { addRasterLayer, newDocument } from "../src/editor/model/document";
import { EditorSession, type SelectionTrail } from "../src/editor/model/session";
import { rectRegion, type ComposedRegion, type Region } from "../src/editor/model/region";
import { actionList, SESSION_START } from "../src/editor/view/actions-list";

function image(width: number, height: number): RgbaImage {
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
}

const STICKER_CANVAS = startCanvas(STICKER);

function session(): EditorSession {
  return new EditorSession(newDocument(image(4, 4), "base", STICKER_CANVAS));
}

const NO_SELECTION: SelectionTrail = { states: [null], currentIndex: 0 };

function box(x0: number, y0: number, x1: number, y1: number): Region {
  return rectRegion({ x: x0, y: y0 }, { x: x1, y: y1 })!;
}

/** A composed selection from its contributions, as the wand and shape paths store them. */
function composed(...parts: Array<"add" | "subtract">): ComposedRegion {
  return {
    kind: "compose",
    contributions: parts.map((op) => ({ kind: "poly", op, feather: true, points: box(0, 0, 2, 2).points })),
    outlines: [box(0, 0, 2, 2).points],
  };
}

test("a fresh session lists its start row and says there are no actions yet", () => {
  const model = actionList({ labels: [null], currentIndex: 0 }, NO_SELECTION);
  expect(model.rows).toEqual([{ text: SESSION_START, current: true, nested: false, select: false }]);
  expect(model.empty).toBe(true);
});

test("the document trail renders oldest first with the present marked; redoable rows stay", () => {
  const model = actionList({ labels: [null, "Add image as layer", "Move layer up"], currentIndex: 1 }, NO_SELECTION);
  expect(model.rows.map((r) => r.text)).toEqual([SESSION_START, "Add image as layer", "Move layer up"]);
  expect(model.rows.map((r) => r.current)).toEqual([false, true, false]);
  expect(model.empty).toBe(false);
});

test("the selection's steps nest under one Select row, after the last document action", () => {
  const selection: SelectionTrail = { states: [null, box(0, 0, 2, 2), composed("add", "subtract")], currentIndex: 2 };
  const model = actionList({ labels: [null, "Add text"], currentIndex: 1 }, selection);
  expect(model.rows.map((r) => [r.text, r.nested, r.select])).toEqual([
    [SESSION_START, false, false],
    ["Add text", false, false],
    ["Select", false, true],
    ["+ rectangle region", true, false],
    ["− rectangle region", true, false],
  ]);
  expect(model.rows.filter((r) => r.nested).every((r) => !r.current)).toBe(true);
});

test("a composed step is named by its own contribution; a lasso is not a rectangle", () => {
  const lasso: Region = {
    kind: "compose",
    contributions: [{ kind: "poly", op: "add", feather: false, points: [{ x: 0, y: 0 }, { x: 3, y: 1 }, { x: 1, y: 4 }] }],
    outlines: [],
  };
  const wand: Region = {
    kind: "compose",
    contributions: [{ kind: "wand", op: "add", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, mask: { width: 1, height: 1, pixels: new Uint8Array(1) } }],
    outlines: [],
  };
  const model = actionList({ labels: [null], currentIndex: 0 }, { states: [null, lasso, wand], currentIndex: 2 });
  expect(model.rows.slice(1).map((r) => r.text)).toEqual(["Select", "+ lasso region", "+ wand region"]);
});

test("a polygon's drawing tool names it; the axis-aligned geometry is only the fallback", () => {
  // A lasso that happens to be a box is still a lasso, and a rectangle with
  // an irregular outline is still a rectangle: the tool that drew it wins.
  const lasso: Region = {
    kind: "compose",
    contributions: [{ kind: "poly", op: "add", feather: false, shape: "lasso", points: box(0, 0, 2, 2).points }],
    outlines: [],
  };
  const rect: Region = {
    kind: "compose",
    contributions: [
      { kind: "poly", op: "add", feather: false, shape: "rectangle", points: [{ x: 0, y: 0 }, { x: 3, y: 1 }, { x: 1, y: 4 }] },
    ],
    outlines: [],
  };
  const model = actionList({ labels: [null], currentIndex: 0 }, { states: [null, lasso, rect], currentIndex: 2 });
  expect(model.rows.slice(1).map((r) => r.text)).toEqual(["Select", "+ lasso region", "+ rectangle region"]);
});

test("no selection, or a trail cleared by a document edit, means no Select row", () => {
  const s = session();
  expect(actionList({ labels: [null], currentIndex: 0 }, s.selectionTrail()).rows).toHaveLength(1);
  s.commitRegion(box(0, 0, 2, 2));
  expect(s.selectionTrail()).toEqual({ states: [null, box(0, 0, 2, 2)], currentIndex: 1 });
  expect(actionList({ labels: [null], currentIndex: 0 }, s.selectionTrail()).rows.map((r) => r.text)).toEqual([
    SESSION_START,
    "Select",
    "+ rectangle region",
  ]);
  // SPM-23: the next document edit clears the step trail. A plain
  // Rectangle/Lasso selection itself survives (unanchored geometry), so the
  // panel honestly keeps its one current step.
  s.apply("Add image as layer", (doc) => addRasterLayer(doc, image(1, 1), "cutout"));
  expect(s.selectionTrail()).toEqual({ states: [box(0, 0, 2, 2)], currentIndex: 0 });
  expect(actionList(s.actionTrail(), s.selectionTrail()).rows.map((r) => r.text)).toEqual([
    SESSION_START,
    "Add image as layer",
    "Select",
    "+ rectangle region",
  ]);
  // A composed selection dies with the edit (its wand fills are bound to
  // layer pixels), so its rows vanish entirely.
  s.commitRegion(composed("add"));
  s.apply("Add image as layer", (doc) => addRasterLayer(doc, image(1, 1), "second"));
  expect(s.selectionTrail()).toEqual({ states: [null], currentIndex: 0 });
  expect(actionList(s.actionTrail(), s.selectionTrail()).rows.map((r) => r.text)).toEqual([
    SESSION_START,
    "Add image as layer",
    "Add image as layer",
  ]);
});

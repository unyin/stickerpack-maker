// The magic-wand selection's pure rules (SPM-22, owner decisions 2026-11-24):
// the tolerance's range and drag, the Shift/Alt mask combination, the
// outline trace, the blockers, and the session's wand-region invalidation.
import { expect, test } from "bun:test";
import type { RgbaImage } from "../src/editor/model/image";
import { startCanvas, STICKER } from "../src/editor/model/constraints";
import {
  addRasterLayer,
  addTextLayer,
  IDENTITY,
  newDocument,
  setLayerImage,
  type Doc,
  type Point,
  type TextRender,
  type TextStyle,
} from "../src/editor/model/document";
import { EditorSession } from "../src/editor/model/session";
import { rectRegion, regionBounds, type WandRegion } from "../src/editor/model/region";
import {
  anyCovered,
  combineMasks,
  moveWandGesture,
  refillStepOf,
  startWandGesture,
  TOLERANCE,
  toleranceProblem,
  traceOutlines,
  wandModeFor,
  wandReadout,
  type WandMask,
} from "../src/editor/model/wand";
import { decodeWandFrame } from "../src/editor/api";
import { cutBlocker, eraseBlocker } from "../src/editor/view/geometry";

function image(width: number, height: number): RgbaImage {
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
}

/** The canvas a Sticker-mode session starts with. */
const STICKER_CANVAS = startCanvas(STICKER);

function mask(x: number, y: number, width: number, height: number, coverage: number[]): WandMask {
  return { x, y, width, height, coverage: new Uint8Array(coverage) };
}

/** A wand region on the base layer of `doc`, drawn on an identity transform. */
function wandRegion(doc: Doc, m: WandMask): WandRegion {
  return { kind: "wand", targetId: doc.layers[0].id, mask: m, outlines: traceOutlines(m, IDENTITY) };
}

test("tolerances are whole percents within the range", () => {
  expect(TOLERANCE.min).toBe(0);
  expect(TOLERANCE.initial).toBe(20);
  expect(toleranceProblem(0)).toBeNull();
  expect(toleranceProblem(100)).toBeNull();
  expect(toleranceProblem(20.5)).toContain("whole number");
  expect(toleranceProblem(-1)).toContain("whole number");
  expect(toleranceProblem(101)).toContain("whole number");
});

test("a plain click replaces, Shift adds, Alt subtracts, and Shift wins over Alt", () => {
  expect(wandModeFor(false, false)).toBe("replace");
  expect(wandModeFor(true, false)).toBe("add");
  expect(wandModeFor(false, true)).toBe("subtract");
  expect(wandModeFor(true, true)).toBe("add");
});

test("combining masks takes the stronger coverage and unions the bounds", () => {
  const base = mask(0, 0, 2, 1, [255, 0]);
  const fill = mask(1, 0, 2, 1, [128, 255]);
  // Adding: the overlap keeps the stronger coverage.
  expect(combineMasks(base, fill, "add")).toEqual(mask(0, 0, 3, 1, [255, 128, 255]));
  // Subtracting: the fill's coverage is removed outright, floored at nothing.
  expect(combineMasks(base, fill, "subtract")).toEqual(mask(0, 0, 3, 1, [255, 0, 0]));
  // Subtracting removes the fill's coverage outright: a region subtracted
  // from itself empties completely, feather ring included.
  expect(combineMasks(mask(0, 0, 1, 1, [128]), mask(0, 0, 1, 1, [128]), "subtract").coverage[0]).toBe(0);
  expect(combineMasks(mask(0, 0, 1, 1, [255]), mask(0, 0, 1, 1, [128]), "subtract").coverage[0]).toBe(127);
  // Replacing, or combining with nothing, is the fill alone.
  expect(combineMasks(base, fill, "replace")).toBe(fill);
  expect(combineMasks(null, fill, "subtract")).toBe(fill);
});

test("a mask that covers nothing is not a selection", () => {
  expect(anyCovered(mask(0, 0, 1, 1, [255]))).toBe(true);
  expect(anyCovered(mask(0, 0, 1, 1, [0]))).toBe(false);
});

test("a drag sets the tolerance vertically and clamps it to the range", () => {
  const seed: Point = { x: 10, y: 100 };
  const press = startWandGesture(seed, 20);
  expect(press.dragged).toBe(false);
  expect(wandReadout(press)).toBe("Tolerance 20%");
  // Within the slop (screen px) the press is still a click.
  const still = moveWandGesture(press, { x: 12, y: 101 }, 1);
  expect(still).toBe(press);
  // Up increases, down decreases, measured in screen px at any zoom.
  const up = moveWandGesture(press, { x: 10, y: 60 }, 1); // 40 screen px up
  expect(up.dragged).toBe(true);
  expect(up.tolerance).toBe(40);
  expect(wandReadout(up)).toBe("Tolerance 40%");
  const zoomed = moveWandGesture(press, { x: 10, y: 80 }, 2); // 40 screen px up at 2x
  expect(zoomed.tolerance).toBe(40);
  const down = moveWandGesture(up, { x: 10, y: 260 }, 1); // 200 screen px below the press
  expect(down.tolerance).toBe(0);
  const far = moveWandGesture(press, { x: 10, y: -500 }, 1);
  expect(far.tolerance).toBe(100);
});

test("refill steps quantize the tolerance a drag re-fills at", () => {
  expect(refillStepOf(20)).toBe(4);
  expect(refillStepOf(24)).toBe(4);
  expect(refillStepOf(25)).toBe(5);
});

test("a mask's outlines are its boundaries' corners, in document pixels", () => {
  // One solid 2x2 region: a single four-corner loop.
  const solid = traceOutlines(mask(5, 7, 2, 2, [255, 255, 255, 255]), IDENTITY);
  expect(solid).toEqual([[
    { x: 5, y: 7 },
    { x: 7, y: 7 },
    { x: 7, y: 9 },
    { x: 5, y: 9 },
  ]]);
  // A hole inside loops too: the ring around an uncovered centre.
  const ring = mask(0, 0, 3, 3, [255, 255, 255, 255, 0, 255, 255, 255, 255]);
  const loops = traceOutlines(ring, IDENTITY);
  expect(loops).toHaveLength(2);
  const boxes = loops.map((points) => regionBounds({ kind: "rect", points })).sort((a, b) => a.width - b.width);
  // The hole is one pixel: its corners span (1..2), so its box is 1x1.
  expect(boxes[0]).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  expect(boxes[1]).toEqual({ x: 0, y: 0, width: 3, height: 3 });
  // The mask's own grid maps through the layer's transform.
  const scaled = traceOutlines(mask(0, 0, 2, 2, [255, 255, 255, 255]), { x: 10, y: 0, scaleX: 2, scaleY: 1, rotation: 0 });
  expect(scaled).toEqual([[
    { x: 10, y: 0 },
    { x: 14, y: 0 },
    { x: 14, y: 2 },
    { x: 10, y: 2 },
  ]]);
});

test("the wand mask frame decodes its place, size and coverage", () => {
  // WandMask::to_frame: i32 x, i32 y, u32 width, u32 height, then coverage.
  const frame = new ArrayBuffer(16 + 2);
  const header = new DataView(frame, 0, 16);
  header.setInt32(0, -1, true);
  header.setInt32(4, 2, true);
  header.setUint32(8, 2, true);
  header.setUint32(12, 1, true);
  new Uint8Array(frame, 16).set([255, 128]);
  expect(decodeWandFrame(frame)).toEqual({ x: -1, y: 2, width: 2, height: 1, coverage: new Uint8Array([255, 128]) });
  expect(() => decodeWandFrame(new ArrayBuffer(8))).toThrow("truncated");
  expect(() => decodeWandFrame(frame.slice(0, 17))).toThrow("coverage bytes");
});

test("Cut lifts a wand selection from its own target, whoever is selected", () => {
  const doc = newDocument(image(10, 10), "base", STICKER_CANVAS);
  const base = doc.layers[0].id;
  // The base layer sits centred on the canvas; its rectangles start there.
  const at = doc.layers[0].transform;
  const region = wandRegion(doc, mask(0, 0, 4, 4, new Array(16).fill(255)));
  // The click selected the target, so Cut runs.
  expect(cutBlocker(doc, [base], region)).toBeNull();
  // Another layer selected: the wand selection does not belong to it.
  const withOther = addRasterLayer(doc, image(10, 10), "pasted", { ...IDENTITY, x: 0, y: 0 });
  expect(cutBlocker(withOther, [withOther.layers[1].id], region)).toBe("The selection does not touch the selected layer.");
  expect(cutBlocker(doc, [], region)).toBe("Select the one image layer to cut from.");
  // Rect/Lasso selections keep their own rules (SPM-9).
  const rect = rectRegion({ x: at.x, y: at.y }, { x: at.x + 4, y: at.y + 4 })!;
  expect(cutBlocker(doc, [base], rect)).toBeNull();
  expect(cutBlocker(doc, [base], rectRegion({ x: 2000, y: 2000 }, { x: 2004, y: 2004 }))).toBe(
    "The selection does not touch the selected layer.",
  );
});

test("Delete erases a drawn selection from the layer it belongs to", () => {
  const doc = newDocument(image(10, 10), "base", STICKER_CANVAS);
  const base = doc.layers[0].id;
  const at = doc.layers[0].transform;
  // A wand selection needs no layer selected: its target is its own.
  expect(eraseBlocker(doc, [], wandRegion(doc, mask(0, 0, 4, 4, new Array(16).fill(255))))).toBeNull();
  // A Rectangle/Lasso erases from the one selected image layer it touches.
  expect(eraseBlocker(doc, [base], rectRegion({ x: at.x, y: at.y }, { x: at.x + 4, y: at.y + 4 }))).toBeNull();
  expect(eraseBlocker(doc, [], rectRegion({ x: at.x, y: at.y }, { x: at.x + 4, y: at.y + 4 }))).toBe(
    "Select the one image layer to erase from.",
  );
  expect(eraseBlocker(doc, [base], rectRegion({ x: 2000, y: 2000 }, { x: 2004, y: 2004 }))).toBe(
    "The selection does not touch the selected layer.",
  );
  // A text layer has no pixels to erase, as it has none to cut.
  const hi: TextStyle = { text: "hi", fontFamily: "Arial", fontSize: 50, color: "#ff0000", outline: null };
  const rendered: TextRender = {
    image: image(60, 50),
    metrics: { originX: 2, originY: 0, ascent: 40, descent: 10, lineHeight: 60 },
  };
  const withText = addTextLayer(doc, hi, rendered, { ...IDENTITY, x: at.x, y: at.y });
  expect(eraseBlocker(withText, [withText.layers[1].id], rectRegion({ x: at.x, y: at.y }, { x: at.x + 4, y: at.y + 4 }))).toBe(
    "Text layers have no pixels to erase: merge the text into an image layer first.",
  );
});

test("a wand region dies with any document change; a rectangle's survives", () => {
  const session = new EditorSession(newDocument(image(4, 4), "base", STICKER_CANVAS));
  const base = session.doc.layers[0].id;
  const region = wandRegion(session.doc, mask(0, 0, 2, 2, [255, 255, 255, 255]));
  session.setRegion(region);
  // An edit that changes nothing keeps it (no history step, no drop).
  session.apply((doc) => doc);
  expect(session.region).toBe(region);
  // Any real change drops it: the mask no longer lines up with the pixels.
  session.apply((doc) => setLayerImage(doc, base, image(4, 4)));
  expect(session.region).toBeNull();
  // A rectangle region is plain geometry and survives edits.
  const rect = rectRegion({ x: 0, y: 0 }, { x: 2, y: 2 })!;
  session.setRegion(rect);
  session.apply((doc) => setLayerImage(doc, base, image(4, 4)));
  expect(session.region).toBe(rect);
  // Undo reaches back past both edits: a wand region would not survive it.
  session.setRegion(region);
  session.undo();
  expect(session.region).toBeNull();
});

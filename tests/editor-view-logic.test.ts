// Pure decisions behind the Editor view (src/editor/view/geometry.ts):
// fitting, zooming, merge eligibility, click modifiers.
import { expect, test } from "bun:test";
import { IMPORT_MAX_SIDE, type RgbaImage } from "../src/editor/model/image";
import { startCanvas, STICKER, THUMBNAIL } from "../src/editor/model/constraints";
import { addRasterLayer, addTextLayer, fitToBox, newDocument, scaleLongestSide } from "../src/editor/model/document";
import {
  deleteBlocker,
  fitView,
  MAX_ZOOM,
  mergeBlocker,
  MIN_ZOOM,
  selectModeFor,
  sizeToolBlocker,
  zoomAround,
} from "../src/editor/view/geometry";

function image(width: number, height: number): RgbaImage {
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
}

/** The canvas a Sticker-mode session starts with. */
const STICKER_CANVAS = startCanvas(STICKER);

test("fitView centres the document and never upscales past 1:1", () => {
  // 1000x500 doc in an 800x600 view with 20 px margin: scale 760/1000.
  const big = fitView({ width: 800, height: 600 }, { width: 1000, height: 500 }, 20);
  expect(big.scale).toBeCloseTo(0.76);
  expect(big.x).toBeCloseTo((800 - 1000 * 0.76) / 2);
  expect(big.y).toBeCloseTo((600 - 500 * 0.76) / 2);
  // A small doc stays at 100% (no blurry upscaling), centred.
  const small = fitView({ width: 800, height: 600 }, { width: 100, height: 50 }, 20);
  expect(small.scale).toBe(1);
  expect(small.x).toBe(350);
  expect(small.y).toBe(275);
});

test("zoomAround keeps the point under the pointer fixed and clamps", () => {
  const view = { scale: 1, x: 0, y: 0 };
  const pointer = { x: 200, y: 100 };
  const zoomed = zoomAround(view, pointer, -1); // wheel up: zoom in
  expect(zoomed.scale).toBeGreaterThan(1);
  // The document point under the pointer is unchanged.
  const before = { x: (pointer.x - view.x) / view.scale, y: (pointer.y - view.y) / view.scale };
  const after = { x: (pointer.x - zoomed.x) / zoomed.scale, y: (pointer.y - zoomed.y) / zoomed.scale };
  expect(after.x).toBeCloseTo(before.x);
  expect(after.y).toBeCloseTo(before.y);
  expect(zoomAround(view, pointer, 1).scale).toBeLessThan(1);
  expect(zoomAround({ scale: MAX_ZOOM, x: 0, y: 0 }, pointer, -1).scale).toBe(MAX_ZOOM);
  expect(zoomAround({ scale: MIN_ZOOM, x: 0, y: 0 }, pointer, 1).scale).toBe(MIN_ZOOM);
});

test("merge needs two or more selected raster layers, and says why not", () => {
  let doc = newDocument(image(10, 10), "base", STICKER_CANVAS);
  doc = addRasterLayer(doc, image(2, 2), "cutout");
  doc = addTextLayer(doc, { text: "hi", fontFamily: "Arial", fontSize: 12, color: "#000" });
  const [base, cutout, text] = doc.layers.map((l) => l.id);
  expect(mergeBlocker(doc, [])).toBe("Select two or more layers to merge.");
  expect(mergeBlocker(doc, [base])).toBe("Select two or more layers to merge.");
  expect(mergeBlocker(doc, [base, cutout])).toBeNull();
  expect(mergeBlocker(doc, [base, text])).toContain("text");
});

test("Ctrl, Cmd or Shift turn a click into a toggle", () => {
  expect(selectModeFor({ ctrlKey: false, metaKey: false, shiftKey: false })).toBe("replace");
  expect(selectModeFor({ ctrlKey: true, metaKey: false, shiftKey: false })).toBe("toggle");
  expect(selectModeFor({ ctrlKey: false, metaKey: true, shiftKey: false })).toBe("toggle");
  expect(selectModeFor({ ctrlKey: false, metaKey: false, shiftKey: true })).toBe("toggle");
});

test("delete needs a selection and must leave at least one layer, and says why not", () => {
  let doc = newDocument(image(10, 10), "base", STICKER_CANVAS);
  doc = addRasterLayer(doc, image(2, 2), "cutout");
  const [base, cutout] = doc.layers.map((l) => l.id);
  expect(deleteBlocker(doc, [])).toBe("Select the layers to delete.");
  expect(deleteBlocker(doc, [cutout])).toBeNull();
  expect(deleteBlocker(doc, [base, cutout])).toBe(
    "A session needs at least one layer; use Close to start over.",
  );
  const single = newDocument(image(4, 4), "only", STICKER_CANVAS);
  expect(deleteBlocker(single, [single.layers[0].id])).toContain("at least one layer");
});

test("sizeToolBlocker explains each disabled sizing tool, for the active constraint set", () => {
  const doc = newDocument(image(300, 200), "b", STICKER_CANVAS);
  const content = { x: 0, y: 0, width: 300, height: 200 };
  expect(sizeToolBlocker("fit", doc, content, NaN, STICKER)).toBeNull();
  expect(sizeToolBlocker("longest", doc, content, NaN, STICKER)).toBeNull();
  expect(sizeToolBlocker("free", doc, content, 400, STICKER)).toBeNull();
  expect(sizeToolBlocker("free", doc, content, NaN, STICKER)).toBe(
    `The longest side must be a whole number of pixels from 1 to ${IMPORT_MAX_SIDE}.`,
  );
  expect(sizeToolBlocker("free", doc, content, 300, STICKER)).toBe("The image's longest side is already 300 px.");
  expect(sizeToolBlocker("fit", doc, null, NaN, STICKER)).toBe("There is nothing to resize.");
  // Once a tool has run, it is disabled with the set's own side in the message.
  for (const set of [STICKER, THUMBNAIL]) {
    const S = set.side;
    const short = S * (200 / 300);
    const fitted = fitToBox(doc, content, S);
    const filled = { x: 0, y: Math.floor((S - short) / 2), width: S, height: short };
    expect(sizeToolBlocker("fit", fitted, filled, NaN, set)).toBe(`The image already fills ${S}×${S}.`);
    const scaled = scaleLongestSide(doc, content, S);
    const placed = { x: 0, y: 0, width: S, height: short };
    expect(sizeToolBlocker("longest", scaled, placed, NaN, set)).toBe(`The image's longest side is already ${S} px.`);
  }
});

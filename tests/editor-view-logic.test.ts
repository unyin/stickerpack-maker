// Pure decisions behind the Editor view (src/editor/view/geometry.ts):
// fitting, zooming, placement, merge eligibility, click modifiers.
import { expect, test } from "bun:test";
import type { RgbaImage } from "../src/editor/model/image";
import { addRasterLayer, addTextLayer, newDocument } from "../src/editor/model/document";
import {
  centeredPlacement,
  deleteBlocker,
  fitView,
  MAX_ZOOM,
  mergeBlocker,
  MIN_ZOOM,
  selectModeFor,
  zoomAround,
} from "../src/editor/view/geometry";

function image(width: number, height: number): RgbaImage {
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
}

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

test("an added image is centred on the document at its own size", () => {
  const doc = newDocument(image(100, 80), "base");
  expect(centeredPlacement(doc, image(20, 10))).toEqual({
    x: 40,
    y: 35,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
  });
  // Larger than the document: still centred (it overhangs evenly).
  expect(centeredPlacement(doc, image(200, 80)).x).toBe(-50);
  // Odd differences land on whole pixels.
  expect(centeredPlacement(doc, image(21, 11))).toMatchObject({ x: 40, y: 35 });
});

test("merge needs two or more selected raster layers, and says why not", () => {
  let doc = newDocument(image(10, 10), "base");
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
  let doc = newDocument(image(10, 10), "base");
  doc = addRasterLayer(doc, image(2, 2), "cutout");
  const [base, cutout] = doc.layers.map((l) => l.id);
  expect(deleteBlocker(doc, [])).toBe("Select the layers to delete.");
  expect(deleteBlocker(doc, [cutout])).toBeNull();
  expect(deleteBlocker(doc, [base, cutout])).toBe(
    "A session needs at least one layer; use Close to start over.",
  );
  const single = newDocument(image(4, 4), "only");
  expect(deleteBlocker(single, [single.layers[0].id])).toContain("at least one layer");
});

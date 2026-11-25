// Pure decisions behind the Editor view (src/editor/view/geometry.ts):
// fitting, zooming, merge eligibility, click modifiers.
import { expect, test } from "bun:test";
import { IMPORT_MAX_SIDE, type RgbaImage } from "../src/editor/model/image";
import { startCanvas, STICKER, THUMBNAIL } from "../src/editor/model/constraints";
import {
  addRasterLayer,
  addTextLayer,
  fillToBox,
  fitToBox,
  IDENTITY,
  newDocument,
  scaleLongestSide,
  setTransform,
} from "../src/editor/model/document";
import {
  deleteBlocker,
  fitView,
  hexOf,
  MAX_ZOOM,
  mergeBlocker,
  MIN_ZOOM,
  selectModeFor,
  selectedLayerSize,
  sizeToolBlocker,
  panView,
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
  expect(big.y).toBeCloseTo((600 - 500 * 0.76) / 2, 0);
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

test("merge needs two or more selected layers, text included, and says why not", () => {
  let doc = newDocument(image(10, 10), "base", STICKER_CANVAS);
  doc = addRasterLayer(doc, image(2, 2), "cutout");
  doc = addTextLayer(
    doc,
    { text: "hi", fontFamily: "Arial", fontSize: 12, color: "#000000", outline: null },
    { image: image(10, 5), metrics: { originX: 0, originY: 0, ascent: 8, descent: 2, lineHeight: 11 } },
  );
  const [base, cutout, text] = doc.layers.map((l) => l.id);
  expect(mergeBlocker([])).toBe("Select two or more layers to merge.");
  expect(mergeBlocker([base])).toBe("Select two or more layers to merge.");
  expect(mergeBlocker([base, cutout])).toBeNull();
  expect(mergeBlocker([base, text])).toBeNull();
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
  }
  const S = STICKER.side;
  const scaled = scaleLongestSide(doc, content, S);
  const placed = { x: 0, y: 0, width: S, height: S * (200 / 300) };
  expect(sizeToolBlocker("longest", scaled, placed, NaN, STICKER)).toBe(`The image's longest side is already ${S} px.`);
});

test("Longest side is greyed out with a reason when the set needs a square canvas", () => {
  const content = { x: 0, y: 0, width: 300, height: 200 };
  // Sticker mode: Longest side runs; Thumbnail mode: Fit runs, Longest side never does.
  const sticker = newDocument(image(300, 200), "b", startCanvas(STICKER));
  expect(sizeToolBlocker("longest", sticker, content, NaN, STICKER)).toBeNull();
  const thumb = newDocument(image(300, 200), "b", startCanvas(THUMBNAIL));
  const T = THUMBNAIL.side;
  expect(sizeToolBlocker("fit", thumb, content, NaN, THUMBNAIL)).toBeNull();
  const reason = `A thumbnail must be exactly ${T}×${T}, so use Fit in ${T}.`;
  expect(sizeToolBlocker("longest", thumb, content, NaN, THUMBNAIL)).toBe(reason);
  expect(sizeToolBlocker("longest", thumb, null, NaN, THUMBNAIL)).toBe(reason);
  // Free resize is the same in both modes.
  expect(sizeToolBlocker("free", thumb, content, 50, THUMBNAIL)).toBeNull();
});

test("Fill runs in both modes; once it has run, the blocker says the image already covers the side", () => {
  // 384x256: the ratios are exact in floating point, so the post-Fill
  // content rect is exactly what the blocker recomputes.
  const doc = newDocument(image(384, 256), "b", STICKER_CANVAS);
  const content = { x: 0, y: 0, width: 384, height: 256 };
  for (const set of [STICKER, THUMBNAIL]) {
    const S = set.side;
    expect(sizeToolBlocker("fill", doc, content, NaN, set)).toBeNull();
    expect(sizeToolBlocker("fill", doc, null, NaN, set)).toBe("There is nothing to resize.");
    // After a Fill: side-square canvas, shortest side S, centred -> no-op.
    const wide = 384 * (S / 256); // the landscape content spills left and right
    const filled = { x: Math.floor((S - wide) / 2), y: 0, width: wide, height: S };
    expect(sizeToolBlocker("fill", fillToBox(doc, content, S), filled, NaN, set)).toBe(
      `The image already covers ${S}×${S}.`,
    );
  }
});

test("the free-resize blocker follows the side-kind choice (CMT-152)", () => {
  const doc = newDocument(image(300, 200), "b", STICKER_CANVAS);
  const content = { x: 0, y: 0, width: 300, height: 200 };
  expect(sizeToolBlocker("free", doc, content, NaN, STICKER, "shortest")).toBe(
    `The shortest side must be a whole number of pixels from 1 to ${IMPORT_MAX_SIDE}.`,
  );
  // The shortest side is 200: entered 200 changes nothing; entered as the
  // longest side it would change something.
  expect(sizeToolBlocker("free", doc, content, 200, STICKER, "shortest")).toBe(
    "The image's shortest side is already 200 px.",
  );
  expect(sizeToolBlocker("free", doc, content, 200, STICKER, "longest")).toBeNull();
});

test("the selected layer's size is its on-canvas bounding box, whole px (owner decision 2026-11-23)", () => {
  const doc = newDocument(image(300, 200), "base", STICKER_CANVAS);
  const base = doc.layers[0].id;
  // Nothing with no layer or several layers selected.
  expect(selectedLayerSize(doc, [])).toBeNull();
  expect(selectedLayerSize(doc, [base, "layer-9"])).toBeNull();
  expect(selectedLayerSize(doc, [base])).toBe("300×200");
  // Scaled: the box grows with the layer.
  const scaled = setTransform(doc, base, { ...IDENTITY, x: 0, y: 0, scaleX: 2, scaleY: 2 });
  expect(selectedLayerSize(scaled, [base])).toBe("600×400");
  // Rotated 30 degrees: the axis-aligned box on the canvas, NOT the layer's
  // own 300x200 (that was the owner-rejected scaled-size reading).
  const rotated = setTransform(doc, base, { ...IDENTITY, x: 100, y: 100, rotation: 30 });
  expect(selectedLayerSize(rotated, [base])).toBe("360×324");
  // A text layer is measured by its rendered box (CMT-61), like everywhere.
  const text = addTextLayer(
    doc,
    { text: "hi", fontFamily: "Arial", fontSize: 12, color: "#000000", outline: null },
    { image: image(100, 15), metrics: { originX: 0, originY: 0, ascent: 8, descent: 2, lineHeight: 11 } },
    { ...IDENTITY, scaleX: 2, scaleY: 2 },
  );
  expect(selectedLayerSize(text, [text.layers[1].id])).toBe("200×30");
});

test("fitView offsets are whole device pixels, so adjacent layers show no seams", () => {
  // 101x100 doc in a 200x193 view: the centred offsets would be 49.5 and 46.5.
  const v = fitView({ width: 200, height: 193 }, { width: 101, height: 100 }, 0);
  expect(v.scale).toBe(1);
  expect(Number.isInteger(v.x)).toBe(true);
  expect(Number.isInteger(v.y)).toBe(true);
  expect([v.x, v.y]).toEqual([Math.round(49.5), Math.round(46.5)]);
  const scaled = fitView({ width: 333, height: 217 }, { width: 1000, height: 700 }, 7);
  expect(Number.isInteger(scaled.x) && Number.isInteger(scaled.y)).toBe(true);
});

test("panView moves the view by the pointer travel and keeps the scale", () => {
  const start = { scale: 2, x: 10, y: -5 };
  expect(panView(start, { x: 100, y: 100 }, { x: 130, y: 80 })).toEqual({ scale: 2, x: 40, y: -25 });
  expect(panView(start, { x: 7, y: 7 }, { x: 7, y: 7 })).toEqual(start);
});

test("a sampled pixel formats as lowercase #rrggbb for the pick loupe", () => {
  // The smoke harness image is [200, 30, 30, 255]: its centre samples this.
  expect(hexOf(200, 30, 30)).toBe("#c81e1e");
  expect(hexOf(171, 52, 205)).toBe("#ab34cd");
  expect(hexOf(255, 255, 255)).toBe("#ffffff");
  // hexOf only formats; the fully transparent refusal happens before it,
  // whatever the colour channels of a transparent pixel hold.
  expect(hexOf(0, 0, 0)).toBe("#000000");
});

// Background removal and the refine brush (SPEC §6, SPM-7): the target
// rules, the restore source the layer keeps, and the brush's pixels. Pure
// TypeScript; the Rust removal is stood in for by plain pixel buffers.
import { expect, test } from "bun:test";
import type { RgbaImage } from "../src/editor/model/image";
import {
  addRasterLayer,
  addTextLayer,
  cutLayer,
  IDENTITY,
  mergeLayers,
  newDocument,
  setLayerImage,
  setTransform,
  type Doc,
  type RasterLayer,
  type Transform,
} from "../src/editor/model/document";
import {
  backgroundTarget,
  refineLayerPixels,
  restoreBlocker,
  RESTORE_NOTHING,
} from "../src/editor/model/background";
import { downloadProgressText, megabytes } from "../src/editor/view/download-text";
import { beginStroke, BRUSH_SIZE, brushSizeProblem, docToLocal, finishStroke, strokeTo } from "../src/editor/model/brush";
import { EditorSession } from "../src/editor/model/session";

function solid(width: number, height: number, px: [number, number, number, number]): RgbaImage {
  const pixels = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let i = 0; i < width * height; i++) pixels.set(px, i * 4);
  return { width, height, pixels };
}

function alphaAt(image: RgbaImage, x: number, y: number): number {
  return image.pixels[(y * image.width + x) * 4 + 3];
}

function pixelAt(image: RgbaImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return [...image.pixels.slice(i, i + 4)];
}

const CANVAS = { width: 512, height: 512 };

function docWith(image: RgbaImage, transform: Transform = IDENTITY): Doc {
  const doc = newDocument(image, "photo", CANVAS);
  return setTransform(doc, "layer-1", transform);
}

function raster(doc: Doc, id = "layer-1"): RasterLayer {
  const layer = doc.layers.find((l) => l.id === id);
  if (!layer || layer.kind !== "raster") throw new Error(`no raster layer ${id}`);
  return layer;
}

const TEXT_RENDER = {
  image: solid(10, 4, [0, 0, 0, 255]),
  metrics: { originX: 0, originY: 0, ascent: 3, descent: 1, lineHeight: 4 },
};
const STYLE = { text: "Hi", fontFamily: "Impact", fontSize: 64, color: "#000000", outline: null };

// ---- Target ----

test("with nothing selected the background tools work on the base image", () => {
  const doc = addRasterLayer(docWith(solid(4, 4, [1, 2, 3, 255])), solid(2, 2, [0, 0, 0, 255]), "top");
  expect(backgroundTarget(doc, [])).toEqual({ layer: raster(doc, "layer-1") });
});

test("with one image layer selected they work on it", () => {
  const doc = addRasterLayer(docWith(solid(4, 4, [1, 2, 3, 255])), solid(2, 2, [0, 0, 0, 255]), "top");
  expect(backgroundTarget(doc, ["layer-2"])).toEqual({ layer: raster(doc, "layer-2") });
});

test("text and several layers are refused with a reason", () => {
  const doc = addTextLayer(docWith(solid(4, 4, [1, 2, 3, 255])), STYLE, TEXT_RENDER);
  expect("reason" in backgroundTarget(doc, ["layer-2"])).toBe(true);
  expect("reason" in backgroundTarget(doc, ["layer-1", "layer-2"])).toBe(true);
  // A text layer at the bottom of the stack is not an image to work on.
  const textBase = { ...doc, layers: [doc.layers[1], doc.layers[0]] };
  expect(backgroundTarget(textBase, [])).toEqual({ reason: "The base layer is text: select an image layer." });
});

// ---- Restore source ----

test("removal keeps the original pixels as the layer's restore source", () => {
  const original = solid(4, 4, [9, 8, 7, 255]);
  const removed = solid(4, 4, [9, 8, 7, 0]);
  const doc = refineLayerPixels(docWith(original), "layer-1", removed);
  expect(raster(doc).image).toBe(removed);
  expect(raster(doc).restoreSource).toBe(original);
  expect(restoreBlocker(raster(doc))).toBeNull();
});

test("a second removal keeps the first restore source", () => {
  const original = solid(4, 4, [9, 8, 7, 255]);
  const once = refineLayerPixels(docWith(original), "layer-1", solid(4, 4, [9, 8, 7, 100]));
  const twice = refineLayerPixels(once, "layer-1", solid(4, 4, [9, 8, 7, 0]));
  expect(raster(twice).restoreSource).toBe(original);
});

test("the same pixels change nothing, and pixels of another size are refused", () => {
  const doc = docWith(solid(4, 4, [9, 8, 7, 255]));
  expect(refineLayerPixels(doc, "layer-1", raster(doc).image)).toBe(doc);
  expect(() => refineLayerPixels(doc, "layer-1", solid(3, 4, [0, 0, 0, 0]))).toThrow();
});

test("a layer that was never refined, or whose pixels were replaced since, has nothing to restore", () => {
  expect(restoreBlocker(raster(docWith(solid(2, 2, [0, 0, 0, 255]))))).toBe(RESTORE_NOTHING);
  const refined = refineLayerPixels(docWith(solid(4, 4, [9, 8, 7, 255])), "layer-1", solid(4, 4, [9, 8, 7, 0]));
  const replaced = setLayerImage(refined, "layer-1", solid(4, 4, [1, 1, 1, 255]));
  expect(restoreBlocker(raster(replaced))).toBe(RESTORE_NOTHING);
  // The reason names the replacing steps generally (effects too) and says to undo first.
  expect(RESTORE_NOTHING).toContain("undo it first");
  expect(RESTORE_NOTHING).toContain("an effect");
});

test("moving the layer keeps its restore source; other pixel operations drop it", () => {
  const refined = refineLayerPixels(docWith(solid(4, 4, [9, 8, 7, 255])), "layer-1", solid(4, 4, [9, 8, 7, 0]));
  const moved = setTransform(refined, "layer-1", { ...IDENTITY, x: 30, rotation: 10 });
  expect(raster(moved).restoreSource).toBeDefined();
  expect(raster(setLayerImage(refined, "layer-1", solid(4, 4, [0, 0, 0, 0]))).restoreSource).toBeUndefined();
  const cut = cutLayer(refined, "layer-1", {
    hole: solid(4, 4, [0, 0, 0, 0]),
    cutout: solid(1, 1, [9, 8, 7, 255]),
    x: 1,
    y: 1,
  });
  expect(raster(cut).restoreSource).toBeUndefined();
  const withTop = addRasterLayer(refined, solid(2, 2, [1, 1, 1, 255]), "top");
  const merged = mergeLayers(withTop, ["layer-1", "layer-2"], solid(4, 4, [1, 1, 1, 255]), IDENTITY);
  expect(merged.layers.every((l) => l.kind !== "raster" || l.restoreSource === undefined)).toBe(true);
});

test("the history budget counts restore sources as pixels the present holds", () => {
  // The step before a removal holds the original as its image; the present
  // holds it as the restore source, so going back costs nothing extra and
  // even a zero budget keeps that step.
  const original = solid(10, 10, [9, 8, 7, 255]);
  const tight = new EditorSession(docWith(original), 0);
  tight.apply((d) => refineLayerPixels(d, "layer-1", solid(10, 10, [9, 8, 7, 0])));
  expect(raster(tight.doc).restoreSource).toBe(original);
  expect(tight.canUndo).toBe(true);
});

// ---- Brush ----

test("an erase dot clears alpha inside its radius and keeps colours", () => {
  const doc = docWith(solid(40, 40, [50, 60, 70, 255]));
  const stroke = beginStroke(raster(doc), "erase", 10);
  const dirty = strokeTo(stroke, { x: 20, y: 20 });
  expect(dirty).not.toBeNull();
  expect(alphaAt(stroke.working, 20, 20)).toBe(0);
  expect(pixelAt(stroke.working, 20, 20).slice(0, 3)).toEqual([50, 60, 70]);
  expect(alphaAt(stroke.working, 20, 27)).toBe(255); // outside the 5 px radius
  expect(alphaAt(stroke.working, 0, 0)).toBe(255);
  // The edge is soft over about one pixel.
  const edge = alphaAt(stroke.working, 22, 24); // its centre is 5.15 px from the dot's
  expect(edge).toBeGreaterThan(0);
  expect(edge).toBeLessThan(255);
  // The dirty rect covers the dot and stays inside the layer.
  expect(dirty!.x).toBeGreaterThanOrEqual(14);
  expect(dirty!.x + dirty!.width).toBeLessThanOrEqual(26);
});

test("a segment erases the whole line between two points", () => {
  const doc = docWith(solid(60, 20, [1, 1, 1, 255]));
  const stroke = beginStroke(raster(doc), "erase", 6);
  strokeTo(stroke, { x: 5, y: 10 });
  strokeTo(stroke, { x: 55, y: 10 });
  for (const x of [5, 15, 30, 45, 54]) expect(alphaAt(stroke.working, x, 10)).toBe(0);
  expect(alphaAt(stroke.working, 30, 2)).toBe(255);
});

test("going over the same spot twice in one stroke does not erase it further", () => {
  const doc = docWith(solid(40, 40, [1, 1, 1, 255]));
  const stroke = beginStroke(raster(doc), "erase", 10);
  strokeTo(stroke, { x: 20, y: 20 });
  const once = alphaAt(stroke.working, 22, 24);
  expect(once).toBeGreaterThan(0);
  strokeTo(stroke, { x: 20, y: 20 });
  expect(alphaAt(stroke.working, 22, 24)).toBe(once);
});

test("the brush is sized in canvas pixels on a scaled, rotated layer", () => {
  // A 100×100 layer drawn at half size and turned 90°: layer px (u, v) is drawn at (200 - v/2, u/2).
  const t: Transform = { x: 200, y: 0, scaleX: 0.5, scaleY: 0.5, rotation: 90 };
  const doc = docWith(solid(100, 100, [1, 1, 1, 255]), t);
  const local = docToLocal(t, 180, 25);
  expect(local.x).toBeCloseTo(50);
  expect(local.y).toBeCloseTo(40);
  const stroke = beginStroke(raster(doc), "erase", 4); // radius 2 canvas px = 4 layer px
  strokeTo(stroke, { x: 180, y: 25 });
  expect(alphaAt(stroke.working, 50, 40)).toBe(0);
  expect(alphaAt(stroke.working, 50, 42)).toBe(0); // its centre is 1.3 canvas px away
  expect(alphaAt(stroke.working, 50, 47)).toBe(255); // 3.5 canvas px away
});

test("painting off the layer changes nothing", () => {
  const doc = docWith(solid(10, 10, [1, 1, 1, 255]));
  const stroke = beginStroke(raster(doc), "erase", 4);
  expect(strokeTo(stroke, { x: 100, y: 100 })).toBeNull();
  expect(finishStroke(doc, stroke)).toBe(doc);
});

test("mid-stroke pixels are only in the stroke's working image until release", () => {
  // Why Save is refused mid-stroke (saveRefusal, SPM-7): between beginStroke
  // and finishStroke the painted pixels are nowhere in the document, so a
  // save would miss them; the release commits them as one step.
  const doc = docWith(solid(40, 40, [1, 1, 1, 255]));
  const stroke = beginStroke(raster(doc), "erase", 10);
  strokeTo(stroke, { x: 20, y: 20 });
  expect(alphaAt(raster(doc).image, 20, 20)).toBe(255); // not in the model yet
  const released = finishStroke(doc, stroke);
  expect(alphaAt(raster(released).image, 20, 20)).toBe(0); // the release commits it
});

test("restore paints the restore source back and needs one", () => {
  const original = solid(20, 20, [9, 8, 7, 255]);
  const removed = solid(20, 20, [9, 8, 7, 0]);
  const doc = refineLayerPixels(docWith(original), "layer-1", removed);
  const stroke = beginStroke(raster(doc), "restore", 6);
  strokeTo(stroke, { x: 10, y: 10 });
  expect(pixelAt(stroke.working, 10, 10)).toEqual([9, 8, 7, 255]);
  expect(alphaAt(stroke.working, 1, 1)).toBe(0);
  expect(() => beginStroke(raster(docWith(original)), "restore", 6)).toThrow();
});

test("a finished stroke is one operation that keeps the restore source", () => {
  const original = solid(20, 20, [9, 8, 7, 255]);
  const doc = docWith(original);
  const stroke = beginStroke(raster(doc), "erase", 6);
  strokeTo(stroke, { x: 10, y: 10 });
  const next = finishStroke(doc, stroke);
  expect(raster(next).image).toBe(stroke.working);
  // The first erase starts the restore source, so Restore can undo it by hand.
  expect(raster(next).restoreSource).toBe(original);
  expect(stroke.start).toBe(original);
  expect(alphaAt(original, 10, 10)).toBe(255); // the model's pixels were never touched
});

test("a stroke whose layer changed meanwhile is dropped", () => {
  const doc = docWith(solid(20, 20, [9, 8, 7, 255]));
  const stroke = beginStroke(raster(doc), "erase", 6);
  strokeTo(stroke, { x: 10, y: 10 });
  const changed = setLayerImage(doc, "layer-1", solid(20, 20, [0, 0, 0, 255]));
  expect(finishStroke(changed, stroke)).toBe(changed);
});

test("brush sizes are whole pixels within the range", () => {
  expect(brushSizeProblem(BRUSH_SIZE.initial)).toBeNull();
  expect(brushSizeProblem(BRUSH_SIZE.min)).toBeNull();
  expect(brushSizeProblem(BRUSH_SIZE.max)).toBeNull();
  for (const bad of [0, BRUSH_SIZE.max + 1, 2.5, NaN]) expect(brushSizeProblem(bad)).not.toBeNull();
});

// ---- Download messages ----

test("download progress reads as a percentage of megabytes", () => {
  expect(megabytes(178_648_008)).toBe("179 MB");
  expect(downloadProgressText({ received: 89_324_004, total: 178_648_008 })).toBe(
    "Downloading the background removal model: 50% (89 of 179 MB)…",
  );
  expect(downloadProgressText({ received: 0, total: 0 })).toContain("0%");
});

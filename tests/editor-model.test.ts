// Editor document model, history, and session (ADR-0005): pure TypeScript,
// no Konva, no DOM.
import { expect, test } from "bun:test";
import { IMPORT_MAX_SIDE, type RgbaImage } from "../src/editor/model/image";
import { readoutStatus, startCanvas, STICKER, THUMBNAIL } from "../src/editor/model/constraints";
import limits from "../src/shared/limits.json";
import {
  addRasterLayer,
  addTextLayer,
  centeredPlacement,
  contentBounds as modelContentBounds,
  deleteLayers,
  fillToBox,
  fitToBox,
  IDENTITY,
  layerIndex,
  mergeLayers,
  moveLayer,
  newDocument,
  nextLayerId,
  placedBounds,
  planCrop,
  resizeSideProblem,
  resizeToSide,
  scaleLongestSide,
  setLayerImage,
  setTransform,
  type Doc,
  type TextRender,
} from "../src/editor/model/document";
import { History } from "../src/editor/model/history";
import { EditorSession } from "../src/editor/model/session";

const contentBounds = (doc: Doc) => modelContentBounds(doc);

/** A text layer's Rust rendering stand-in: a blank box of the given size. */
function textRender(width = 20, height = 10): TextRender {
  return {
    image: image(width, height),
    metrics: { originX: 0, originY: 0, ascent: 8, descent: 2, lineHeight: 11 },
  };
}

function image(width: number, height: number, fill = 0): RgbaImage {
  return {
    width,
    height,
    pixels: new Uint8ClampedArray(width * height * 4).fill(fill),
  };
}

const names = (doc: Doc) => doc.layers.map((l) => l.name);

/** The canvas a Sticker-mode session starts with. */
const STICKER_CANVAS = startCanvas(STICKER);

/**
 * A document whose canvas matches its image (base layer at 0,0), as after
 * Longest side (tool 2): keeps the sizing arithmetic below readable.
 */
function snug(width: number, height: number, name: string): Doc {
  return newDocument(image(width, height), name, { width, height });
}

// ---- Document operations ----

test("the constraint sets come from the shared limits file", () => {
  expect(STICKER).toEqual({
    mode: "sticker",
    side: limits.sticker.side,
    maxKilobytes: limits.sticker.maxKilobytes,
    square: false,
  });
  expect(startCanvas(STICKER)).toEqual({ width: STICKER.side, height: STICKER.side });
  expect(startCanvas(THUMBNAIL)).toEqual({ width: THUMBNAIL.side, height: THUMBNAIL.side });
  expect(THUMBNAIL).toEqual({
    mode: "thumbnail",
    side: limits.thumbnail.side,
    maxKilobytes: limits.thumbnail.maxKilobytes,
    square: true,
  });
});

test("a new document starts at the sticker side, square, with the image at native size, centred", () => {
  const S = STICKER.side;
  const doc = newDocument(image(30, 20), "cat.png", STICKER_CANVAS);
  expect([doc.width, doc.height]).toEqual([S, S]);
  expect(doc.layers.length).toBe(1);
  const base = doc.layers[0];
  expect(base.kind).toBe("raster");
  expect(base.name).toBe("cat.png");
  expect(base.transform).toEqual({ ...IDENTITY, x: Math.round((S - 30) / 2), y: Math.round((S - 20) / 2) });
  // A bigger image overflows the canvas evenly; nothing is scaled.
  const big = newDocument(image(S * 2, S + 100), "big.png", STICKER_CANVAS);
  expect([big.width, big.height]).toEqual([S, S]);
  expect(big.layers[0].transform).toEqual({ ...IDENTITY, x: -S / 2, y: -50 });
  // Thumbnail mode will pass its own starting canvas.
  const thumb = newDocument(image(30, 20), "t", startCanvas(THUMBNAIL));
  expect([thumb.width, thumb.height]).toEqual([THUMBNAIL.side, THUMBNAIL.side]);
});

test("centeredPlacement centres an image on the canvas at its own size, on whole pixels", () => {
  const canvas = { width: 100, height: 80 };
  expect(centeredPlacement(canvas, image(20, 10))).toEqual({ ...IDENTITY, x: 40, y: 35 });
  // Larger than the canvas: still centred (it overhangs evenly).
  expect(centeredPlacement(canvas, image(200, 80)).x).toBe(-50);
  // Odd differences land on whole pixels.
  expect(centeredPlacement(canvas, image(21, 11))).toMatchObject({ x: 40, y: 35 });
});

test("only Fit and Longest side change the canvas size", () => {
  let doc = newDocument(image(800, 300), "base", STICKER_CANVAS);
  doc = addRasterLayer(doc, image(40, 40), "cutout", centeredPlacement(doc, image(40, 40)));
  doc = addTextLayer(doc, { text: "hi", fontFamily: "Arial", fontSize: 12, color: "#000", outline: null }, textRender());
  const [base, cutout, text] = doc.layers.map((l) => l.id);
  doc = setTransform(doc, cutout, { ...IDENTITY, x: 5 });
  doc = moveLayer(doc, text, 0);
  doc = mergeLayers(doc, [base, cutout], image(800, 300), IDENTITY);
  doc = deleteLayers(doc, [text]);
  // Add, move, restack, merge, delete and free resize all keep the canvas.
  const S = STICKER.side;
  doc = resizeToSide(doc, contentBounds(doc), 100);
  expect([doc.width, doc.height]).toEqual([S, S]);
  // Fit sets the square; Longest side sets the scaled image's size (800x300).
  const fitted = fitToBox(doc, contentBounds(doc), S);
  expect([fitted.width, fitted.height]).toEqual([S, S]);
  const scaled = scaleLongestSide(doc, contentBounds(doc), S);
  expect([scaled.width, scaled.height]).toEqual([S, Math.ceil((S * 300) / 800)]);
});

test("in Thumbnail mode the model functions target the thumbnail side (Longest side is greyed out in the UI)", () => {
  const T = THUMBNAIL.side;
  const doc = newDocument(image(800, 300), "base", startCanvas(THUMBNAIL));
  const fitted = fitToBox(doc, contentBounds(doc), T);
  expect([fitted.width, fitted.height]).toEqual([T, T]);
  expect(Math.max(contentBounds(fitted).width, contentBounds(fitted).height)).toBeCloseTo(T);
  const scaled = scaleLongestSide(doc, contentBounds(doc), T);
  expect([scaled.width, scaled.height]).toEqual([T, Math.ceil((T * 300) / 800)]);
});

test("operations are pure: the input document is never changed", () => {
  const doc = newDocument(image(10, 10), "base", STICKER_CANVAS);
  const before = JSON.stringify(doc.layers.map((l) => [l.id, l.name, l.transform]));
  addRasterLayer(doc, image(5, 5), "cutout");
  setTransform(doc, doc.layers[0].id, { ...IDENTITY, x: 3 });
  expect(JSON.stringify(doc.layers.map((l) => [l.id, l.name, l.transform]))).toBe(before);
});

test("new layers go on top with unique ids; text layers carry their text", () => {
  let doc = newDocument(image(10, 10), "base", STICKER_CANVAS);
  doc = addRasterLayer(doc, image(5, 5), "cutout", { ...IDENTITY, x: 2, y: 3 });
  doc = addTextLayer(doc, { text: "hi", fontFamily: "Arial", fontSize: 24, color: "#ff0000", outline: null }, textRender());
  expect(names(doc)).toEqual(["base", "cutout", "hi"]);
  const ids = doc.layers.map((l) => l.id);
  expect(new Set(ids).size).toBe(3);
  const text = doc.layers[2];
  expect(text.kind).toBe("text");
  if (text.kind === "text") expect(text.fontSize).toBe(24);
  expect(doc.layers[1].transform.x).toBe(2);
});

test("the id an add or merge creates equals nextLayerId of the input doc", () => {
  const base = newDocument(image(4, 4), "base", STICKER_CANVAS);
  const raster = addRasterLayer(base, image(1, 1), "a");
  expect(raster.layers[1].id).toBe(nextLayerId(base));
  const text = addTextLayer(raster, { text: "hi", fontFamily: "sans-serif", fontSize: 24, color: "#000", outline: null }, textRender());
  expect(text.layers[2].id).toBe(nextLayerId(raster));
  const merged = mergeLayers(text, [text.layers[0].id, text.layers[1].id], image(1, 1), IDENTITY);
  expect(merged.layers.map((l) => l.id)).toContain(nextLayerId(text));
  expect(nextLayerId(merged)).not.toBe(nextLayerId(text));
});

test("z-order moves clamp to the stack", () => {
  let doc = newDocument(image(4, 4), "a", STICKER_CANVAS);
  doc = addRasterLayer(doc, image(1, 1), "b");
  doc = addRasterLayer(doc, image(1, 1), "c");
  const [a, , c] = doc.layers.map((l) => l.id);
  doc = moveLayer(doc, a, 2);
  expect(names(doc)).toEqual(["b", "c", "a"]);
  doc = moveLayer(doc, c, 99);
  expect(names(doc)).toEqual(["b", "a", "c"]);
  doc = moveLayer(doc, c, -5);
  expect(names(doc)).toEqual(["c", "b", "a"]);
  expect(layerIndex(doc, a)).toBe(2);
  expect(() => moveLayer(doc, "nope", 0)).toThrow();
});

test("transform and image changes reuse untouched layers", () => {
  let doc = newDocument(image(4, 4), "a", STICKER_CANVAS);
  doc = addRasterLayer(doc, image(2, 2), "b");
  const [a, b] = doc.layers;
  const moved = setTransform(doc, b.id, { ...IDENTITY, x: 1, rotation: 45 });
  expect(moved.layers[0]).toBe(a);
  expect(moved.layers[1].transform.rotation).toBe(45);
  const repainted = setLayerImage(doc, b.id, image(2, 2, 9));
  expect(repainted.layers[0]).toBe(a);
  expect(() => setLayerImage(doc, "nope", image(1, 1))).toThrow();
});

test("merge replaces the chosen layers with one at the topmost chosen slot", () => {
  let doc = newDocument(image(4, 4), "a", STICKER_CANVAS);
  doc = addRasterLayer(doc, image(1, 1), "b");
  doc = addRasterLayer(doc, image(1, 1), "c");
  doc = addRasterLayer(doc, image(1, 1), "d");
  const [a, , c] = doc.layers.map((l) => l.id);
  const merged = mergeLayers(doc, [a, c], image(4, 4, 1), { ...IDENTITY, x: -1 });
  // a and c are gone; the merged layer takes c's slot (above b, below d).
  expect(names(merged)).toEqual(["b", "Merged", "d"]);
  expect(merged.layers[1].transform.x).toBe(-1);
  expect(() => mergeLayers(doc, [a], image(1, 1), IDENTITY)).toThrow("two");
  expect(() => mergeLayers(doc, [a, "nope"], image(1, 1), IDENTITY)).toThrow();
});

// ---- History ----

const bytesOf = (doc: Doc) =>
  doc.layers.flatMap((l) => (l.kind === "raster" ? [l.image.pixels.buffer] : []));

test("undo and redo walk the committed states; a new commit clears redo", () => {
  const h = new History<number>(0, { budgetBytes: Infinity, buffersOf: () => [] });
  h.commit(1);
  h.commit(2);
  expect(h.present).toBe(2);
  expect(h.canRedo).toBe(false);
  h.undo();
  h.undo();
  expect(h.present).toBe(0);
  expect(h.canUndo).toBe(false);
  h.undo(); // no-op at the start
  expect(h.present).toBe(0);
  h.redo();
  expect(h.present).toBe(1);
  h.commit(5);
  expect(h.canRedo).toBe(false);
  h.undo();
  expect(h.present).toBe(1);
});

test("unsaved changes means the present is not the saved state", () => {
  const h = new History<string>("imported", { budgetBytes: Infinity, buffersOf: () => [] });
  expect(h.isDirty).toBe(false);
  h.commit("edited");
  expect(h.isDirty).toBe(true);
  h.undo();
  expect(h.isDirty).toBe(false); // undoing back to the saved state is clean
  h.redo();
  h.markSaved();
  expect(h.isDirty).toBe(false);
  h.undo();
  expect(h.isDirty).toBe(true);
});

test("the memory budget drops the oldest steps, counting shared buffers once", () => {
  const MB = 1024 * 1024;
  // Each step repaints the base layer with a fresh 1 MB buffer.
  let doc = newDocument(image(512, 512), "base", STICKER_CANVAS); // 512*512*4 = 1 MB
  const h = new History<Doc>(doc, { budgetBytes: 3 * MB, buffersOf: bytesOf });
  for (let i = 1; i <= 6; i++) {
    doc = setLayerImage(doc, doc.layers[0].id, image(512, 512, i));
    h.commit(doc);
  }
  // Present holds 1 MB (not counted); at most 3 MB of past buffers remain.
  expect(h.retainedBytes).toBeLessThanOrEqual(3 * MB);
  let undos = 0;
  while (h.canUndo) {
    h.undo();
    undos++;
  }
  expect(undos).toBe(3);
  // Pure transform steps share every buffer and cost nothing.
  const h2 = new History<Doc>(doc, { budgetBytes: 0, buffersOf: bytesOf });
  for (let i = 0; i < 50; i++) {
    doc = setTransform(doc, doc.layers[0].id, { ...IDENTITY, x: i });
    h2.commit(doc);
  }
  expect(h2.retainedBytes).toBe(0);
  let steps = 0;
  while (h2.canUndo) {
    h2.undo();
    steps++;
  }
  expect(steps).toBe(50);
});

// ---- Session (history + selection + change notifications) ----

test("selection is not an undo step and is pruned after undo", () => {
  const s = new EditorSession(newDocument(image(4, 4), "base", STICKER_CANVAS));
  const base = s.doc.layers[0].id;
  s.apply((d) => addRasterLayer(d, image(1, 1), "cutout"));
  const cutout = s.doc.layers[1].id;
  s.select(cutout);
  expect(s.selection).toEqual([cutout]);
  expect(s.canUndo).toBe(true);
  s.select(base, "toggle");
  expect(s.selection).toEqual([cutout, base]);
  s.select(cutout, "toggle");
  expect(s.selection).toEqual([base]);
  s.select(cutout); // plain select replaces
  expect(s.selection).toEqual([cutout]);
  s.undo(); // removes the cutout layer
  expect(s.selection).toEqual([]);
  s.redo();
  expect(s.doc.layers.length).toBe(2);
  s.clearSelection();
  expect(s.selection).toEqual([]);
});

test("listeners hear every change; unknown layers cannot be selected", () => {
  const s = new EditorSession(newDocument(image(4, 4), "base", STICKER_CANVAS));
  let heard = 0;
  const off = s.subscribe(() => heard++);
  s.apply((d) => addRasterLayer(d, image(1, 1), "a"));
  s.select(s.doc.layers[1].id);
  s.undo();
  s.redo();
  expect(heard).toBe(4);
  off();
  s.undo();
  expect(heard).toBe(4);
  expect(() => s.select("nope")).toThrow();
});

test("a failing operation leaves the session unchanged", () => {
  const s = new EditorSession(newDocument(image(4, 4), "base", STICKER_CANVAS));
  const before = s.doc;
  expect(() =>
    s.apply((d) => setLayerImage(d, "nope", image(1, 1))),
  ).toThrow();
  expect(s.doc).toBe(before);
  expect(s.canUndo).toBe(false);
  expect(s.isDirty).toBe(false);
});

test("deleting layers removes them in one step and always keeps one", () => {
  let doc = newDocument(image(4, 4), "a", STICKER_CANVAS);
  doc = addRasterLayer(doc, image(1, 1), "b");
  doc = addRasterLayer(doc, image(1, 1), "c");
  const [a, b, c] = doc.layers.map((l) => l.id);
  const left = deleteLayers(doc, [a, c]);
  expect(names(left)).toEqual(["b"]);
  // Untouched layers are reused (structural sharing).
  expect(left.layers[0]).toBe(doc.layers[1]);
  expect(() => deleteLayers(doc, [a, b, c])).toThrow("at least one layer");
  expect(() => deleteLayers(left, [b])).toThrow("at least one layer");
  expect(() => deleteLayers(doc, [])).toThrow();
  expect(() => deleteLayers(doc, ["nope"])).toThrow();
  // Ids are never reused after a delete.
  const next = addRasterLayer(left, image(1, 1), "d");
  expect(next.layers[1].id).not.toBe(c);
});

test("a deletion is one undo step and drops the deleted layers from the selection", () => {
  const s = new EditorSession(newDocument(image(4, 4), "base", STICKER_CANVAS));
  s.apply((d) => addRasterLayer(d, image(1, 1), "x"));
  s.apply((d) => addRasterLayer(d, image(1, 1), "y"));
  const [, x, y] = s.doc.layers.map((l) => l.id);
  s.select(x);
  s.select(y, "toggle");
  s.apply((d) => deleteLayers(d, s.selection));
  expect(names(s.doc)).toEqual(["base"]);
  expect(s.selection).toEqual([]);
  s.undo();
  expect(names(s.doc)).toEqual(["base", "x", "y"]);
});

// ---- Sizing tool 1: fit to 512x512, pad with transparency (SPEC §6) ----
// "Whole image" = everything on the canvas treated as ONE layer (owner,
// 2026-11-20): the union of all layers' bounds is scaled as a group.

test("placedBounds is the on-screen box of a placed layer, rotation included", () => {
  expect(placedBounds(10, 4, { x: 5, y: 6, scaleX: 2, scaleY: 2, rotation: 0 })).toEqual({
    x: 5, y: 6, width: 20, height: 8,
  });
  // 4x2 rotated 90 degrees clockwise about its top-left swings down-left.
  const r = placedBounds(4, 2, { ...IDENTITY, rotation: 90 });
  expect(r.x).toBeCloseTo(-2);
  expect(r.y).toBeCloseTo(0);
  expect(r.width).toBeCloseTo(2);
  expect(r.height).toBeCloseTo(4);
});

test("contentBounds is the union of every raster layer, beyond the canvas too", () => {
  let doc = snug(300, 200, "base");
  doc = addRasterLayer(doc, image(2000, 1000), "big", { ...IDENTITY, x: -850, y: -400 });
  expect(contentBounds(doc)).toEqual({ x: -850, y: -400, width: 2000, height: 1000 });
});

test("fit scales all layers as ONE group so the content's longest side is 512, centred", () => {
  // A 300x200 photo with a 2000x1000 layer over it: the content is the
  // 2000x1000 union, so everything shrinks by 512/2000 = 0.256 together.
  let doc = snug(300, 200, "base");
  doc = addRasterLayer(doc, image(2000, 1000), "big", { ...IDENTITY, x: -850, y: -400 });
  const fitted = fitToBox(doc, contentBounds(doc), 512);
  expect([fitted.width, fitted.height]).toEqual([512, 512]);
  const [base, big] = fitted.layers;
  // Same factor for every layer: the group keeps its proportions.
  expect(base.transform.scaleX).toBeCloseTo(0.256);
  expect(big.transform.scaleX).toBeCloseTo(0.256);
  // The union fills the width and is centred vertically (512x256 + 128 padding).
  expect(big.transform.x).toBeCloseTo(0);
  expect(big.transform.y).toBeCloseTo(128);
  // The base keeps its place inside the group.
  expect(base.transform.x).toBeCloseTo(850 * 0.256);
  expect(base.transform.y).toBeCloseTo(400 * 0.256 + 128);
  expect(contentBounds(fitted).width).toBeCloseTo(512);
  // Pixels, ids and names are untouched (resampling happens at merge/save).
  expect(fitted.layers.map((l) => l.id)).toEqual(doc.layers.map((l) => l.id));
  expect(big.kind === "raster" && big.image).toBe(doc.layers[1].kind === "raster" && doc.layers[1].image);
});

test("fit keeps rotation and works up and down", () => {
  // A single small image grows: a sticker needs one side exactly 512.
  const small = snug(300, 200, "small");
  const grown = fitToBox(small, contentBounds(small), 512);
  expect(grown.layers[0].transform.scaleX).toBeCloseTo(512 / 300);
  expect(grown.layers[0].transform.y).toBe(85); // whole pixel
  // A rotated layer: the group is measured by its rotated box and rotation stays.
  let doc = snug(100, 100, "base");
  doc = addRasterLayer(doc, image(400, 100), "bar", { ...IDENTITY, x: 300, y: 0, rotation: 90 });
  const fitted = fitToBox(doc, contentBounds(doc), 512);
  expect(fitted.layers[1].transform.rotation).toBe(90);
  const after = contentBounds(fitted);
  expect(Math.max(after.width, after.height)).toBeCloseTo(512);
  expect(after.x + after.width / 2).toBeCloseTo(256);
  expect(after.y + after.height / 2).toBeCloseTo(256);
});

test("fitting content that already fills the box changes nothing (no undo step)", () => {
  const doc = snug(512, 512, "done");
  expect(fitToBox(doc, contentBounds(doc), 512)).toBe(doc);
  const s = new EditorSession(doc);
  s.apply((d) => fitToBox(d, contentBounds(d), 512));
  expect(s.canUndo).toBe(false);
  // Same canvas, but content smaller than the box: fit does work.
  const shrunk = setTransform(doc, doc.layers[0].id, { ...IDENTITY, scaleX: 0.5, scaleY: 0.5 });
  expect(fitToBox(shrunk, contentBounds(shrunk), 512)).not.toBe(shrunk);
});

test("fit is one undo step that restores canvas and layers", () => {
  const s = new EditorSession(snug(1000, 500, "base"));
  s.apply((d) => fitToBox(d, contentBounds(d), 512));
  expect([s.doc.width, s.doc.height]).toEqual([512, 512]);
  s.undo();
  expect([s.doc.width, s.doc.height]).toEqual([1000, 500]);
  expect(s.doc.layers[0].transform).toEqual(IDENTITY);
});

// ---- Sizing tool 2: scale the longest side to 512 (SPEC §6) ----
// Same whole-image group as Fit, but the canvas becomes the scaled content
// (no padding). Free resize (tool 3) keeps the canvas; it is tested below.

test("scaling the longest side to 512 shrinks the group and the canvas becomes the content", () => {
  let doc = snug(300, 200, "base");
  doc = addRasterLayer(doc, image(2000, 1000), "big", { ...IDENTITY, x: -850, y: -400 });
  const scaled = scaleLongestSide(doc, contentBounds(doc), 512);
  expect([scaled.width, scaled.height]).toEqual([512, 256]);
  const [base, big] = scaled.layers;
  expect(big.transform.scaleX).toBeCloseTo(0.256);
  expect(base.transform.scaleX).toBeCloseTo(0.256);
  expect(big.transform.x).toBeCloseTo(0);
  expect(big.transform.y).toBeCloseTo(0);
  expect(base.transform.x).toBeCloseTo(850 * 0.256);
  const after = contentBounds(scaled);
  expect(after.width).toBeCloseTo(512);
  expect(after.height).toBeCloseTo(256);
});

test("the short side rounds up so nothing is clipped, content at whole-pixel 0,0", () => {
  // 300x200 -> 512 x 341.33: the short side rounds UP to 342 so nothing is
  // clipped, and the content's top-left sits on a whole pixel.
  const doc = snug(300, 200, "base");
  const scaled = scaleLongestSide(doc, contentBounds(doc), 512);
  expect([scaled.width, scaled.height]).toEqual([512, 342]);
  const after = contentBounds(scaled);
  expect(after.x).toBe(0);
  expect(after.y).toBe(0);
  expect(after.height).toBeCloseTo(341.33, 1);
  expect(after.height).toBeLessThanOrEqual(scaled.height);
  expect(after.width).toBeCloseTo(512);
});

test("fit places the content's top-left on whole pixels", () => {
  const doc = snug(300, 200, "base");
  const fitted = fitToBox(doc, contentBounds(doc), 512);
  expect(fitted.layers[0].transform.y).toBe(85); // (512 - 341.33) / 2 = 85.33 -> 85
  expect(fitted.layers[0].transform.x).toBe(0);
});

test("applying any sizing tool twice is a no-op (no undo step)", () => {
  const tools = [
    (d: Doc) => fitToBox(d, contentBounds(d), 512),
    (d: Doc) => fillToBox(d, contentBounds(d), 512),
    (d: Doc) => scaleLongestSide(d, contentBounds(d), 512),
    (d: Doc) => resizeToSide(d, contentBounds(d), 333),
    (d: Doc) => resizeToSide(d, contentBounds(d), 333, "shortest"),
  ];
  for (const tool of tools) {
    const once = tool(snug(300, 200, "base"));
    expect(tool(once)).toBe(once);
  }
});

test("resizeSideProblem accepts whole numbers from 1 to the import cap only", () => {
  expect(resizeSideProblem(1)).toBeNull();
  expect(resizeSideProblem(IMPORT_MAX_SIDE)).toBeNull();
  const text = `The longest side must be a whole number of pixels from 1 to ${IMPORT_MAX_SIDE}.`;
  for (const bad of [0, IMPORT_MAX_SIDE + 1, 1.5, NaN, -3]) expect(resizeSideProblem(bad)).toBe(text);
  const doc = snug(10, 10, "b");
  expect(() => scaleLongestSide(doc, contentBounds(doc), 0)).toThrow(text);
  // The shortest-side choice (CMT-152) names its side in the same rule.
  const shortest = `The shortest side must be a whole number of pixels from 1 to ${IMPORT_MAX_SIDE}.`;
  expect(resizeSideProblem(600, "shortest")).toBeNull();
  for (const bad of [0, IMPORT_MAX_SIDE + 1, 1.5, NaN, -3]) expect(resizeSideProblem(bad, "shortest")).toBe(shortest);
  expect(() => resizeToSide(doc, contentBounds(doc), 0, "shortest")).toThrow(shortest);
});

test("contentBounds measures text layers by their rendered box under their transform", () => {
  let doc = snug(100, 100, "base");
  const style = { text: "hi", fontFamily: "Arial", fontSize: 20, color: "#000000", outline: null };
  doc = addTextLayer(doc, style, textRender(100, 15), { ...IDENTITY, x: 50, y: -10, scaleX: 2, scaleY: 2 });
  expect(contentBounds(doc)).toEqual({ x: 0, y: -10, width: 250, height: 110 });
});

test("free resize scales the whole image to the entered longest side and keeps the canvas", () => {
  // A 200x400 image centred on the 512x512 canvas (156, 56).
  const tall = newDocument(image(200, 400), "tall", { width: 512, height: 512 });
  const grown = resizeToSide(tall, contentBounds(tall), 1000);
  expect([grown.width, grown.height]).toEqual([512, 512]);
  expect(grown.layers[0].transform.scaleX).toBeCloseTo(2.5);
  // The group keeps its centre (256, 256), top-left on whole pixels.
  expect(contentBounds(grown)).toEqual({ x: 6, y: -244, width: 500, height: 1000 });
  const shrunk = resizeToSide(tall, contentBounds(tall), 100);
  expect([shrunk.width, shrunk.height]).toEqual([512, 512]);
  expect(contentBounds(shrunk)).toEqual({ x: 231, y: 206, width: 50, height: 100 });
  // Several layers scale together as one group.
  let two = addRasterLayer(tall, image(100, 100), "dot", { ...IDENTITY, x: 0, y: 0 });
  two = resizeToSide(two, contentBounds(two), 228);
  expect(two.layers.map((l) => l.transform.scaleX)).toEqual([0.5, 0.5]);
  expect(Math.max(contentBounds(two).width, contentBounds(two).height)).toBeCloseTo(228);
  // Already that size: no change, so no undo step.
  expect(resizeToSide(tall, contentBounds(tall), 400)).toBe(tall);
  for (const bad of [0, 1.5, IMPORT_MAX_SIDE + 1]) {
    expect(() => resizeToSide(tall, contentBounds(tall), bad)).toThrow();
  }
});

test("free resize with the shortest-side choice scales to that side, keeping canvas and centre", () => {
  // A 200x400 image centred on the 512x512 canvas: its shortest side is the width.
  const tall = newDocument(image(200, 400), "tall", { width: 512, height: 512 });
  const grown = resizeToSide(tall, contentBounds(tall), 1000, "shortest");
  expect([grown.width, grown.height]).toEqual([512, 512]);
  const g = contentBounds(grown);
  expect(Math.min(g.width, g.height)).toBeCloseTo(1000);
  expect(g.x + g.width / 2).toBeCloseTo(256);
  expect(g.y + g.height / 2).toBeCloseTo(256);
  const shrunk = resizeToSide(tall, contentBounds(tall), 100, "shortest");
  expect([shrunk.width, shrunk.height]).toEqual([512, 512]);
  expect(contentBounds(shrunk)).toEqual({ x: 206, y: 156, width: 100, height: 200 });
  // Already that size: no change, so no undo step.
  expect(resizeToSide(tall, contentBounds(tall), 200, "shortest")).toBe(tall);
  for (const bad of [0, 1.5, IMPORT_MAX_SIDE + 1]) {
    expect(() => resizeToSide(tall, contentBounds(tall), bad, "shortest")).toThrow();
  }
});

// ---- Sizing tool 4: Fill NxN (SPEC §6) ----
// Fill is to Fit what CSS cover is to contain (owner request 2026-11-21):
// the shortest side becomes the constraint set's side, the canvas becomes
// the side square, the image is centred, and the spill outside the canvas
// is kept (transform-only).

test("fill scales the whole image so its shortest side is the side, canvas side x side, centred", () => {
  // Landscape, portrait and square content, against either constraint set.
  for (const set of [STICKER, THUMBNAIL]) {
    const S = set.side;
    for (const [w, h] of [
      [300, 200],
      [200, 400],
      [300, 300],
    ]) {
      const doc = newDocument(image(w, h), "base", startCanvas(set));
      const filled = fillToBox(doc, contentBounds(doc), S);
      expect([filled.width, filled.height]).toEqual([S, S]);
      const after = contentBounds(filled);
      expect(Math.min(after.width, after.height)).toBeCloseTo(S);
      expect(after.x + after.width / 2).toBeCloseTo(S / 2);
      expect(after.y + after.height / 2).toBeCloseTo(S / 2);
      // The square canvas meets the set, so the readout says OK.
      expect(readoutStatus(filled, set).ok).toBe(true);
    }
  }
});

test("fill spills outside the canvas and keeps the spill: only transforms change", () => {
  // 300x200 content fills 512: it grows to 768x512, centred, so 128 px hang
  // over each side (crop the spill away if wanted, or Save clips it).
  const doc = snug(300, 200, "base");
  const filled = fillToBox(doc, contentBounds(doc), 512);
  const after = contentBounds(filled);
  expect(after.x).toBeCloseTo(-128);
  expect(after.y).toBeCloseTo(0);
  expect(after.width).toBeCloseTo(768);
  expect(after.height).toBeCloseTo(512);
  // Pixels, ids and names are untouched (resampling happens at merge/save).
  expect(filled.layers.map((l) => l.id)).toEqual(doc.layers.map((l) => l.id));
  expect(filled.layers[0].kind === "raster" && filled.layers[0].image).toBe(
    doc.layers[0].kind === "raster" && doc.layers[0].image,
  );
  // The layers' own scale is the group factor; a layer crossing the canvas
  // edge still crosses it, so Crop stays available on the spill.
  const factor = 512 / 200;
  expect(filled.layers[0].transform.scaleX).toBeCloseTo(factor);
  // A layer entirely beyond the new canvas edge is removed by Crop (the
  // spill is visible on the stage, but Crop measures the box only).
  const withDot = addRasterLayer(doc, image(10, 10), "dot", { ...IDENTITY, x: 295, y: 0 });
  const crossing = fillToBox(withDot, contentBounds(withDot), 512);
  const plan = planCrop(crossing, { x: 0, y: 0, width: 512, height: 512 });
  expect(plan[0].kind).toBe("clip"); // the 300-wide base crosses the right edge
  expect(plan[1].kind).toBe("remove"); // the dot at 295..305 hangs outside after scaling
});

test("fill is one undo step that restores canvas and layers", () => {
  const s = new EditorSession(snug(300, 200, "base"));
  s.apply((d) => fillToBox(d, contentBounds(d), 512));
  expect([s.doc.width, s.doc.height]).toEqual([512, 512]);
  expect(Math.min(contentBounds(s.doc).width, contentBounds(s.doc).height)).toBeCloseTo(512);
  s.undo();
  expect([s.doc.width, s.doc.height]).toEqual([300, 200]);
  expect(s.doc.layers[0].transform).toEqual(IDENTITY);
  s.redo();
  expect([s.doc.width, s.doc.height]).toEqual([512, 512]);
});

test("filling content that already covers the side square changes nothing (no undo step)", () => {
  // 600x512 centred on the 512x512 canvas: its shortest side is the side.
  const doc = newDocument(image(600, 512), "cover", { width: 512, height: 512 });
  expect(fillToBox(doc, contentBounds(doc), 512)).toBe(doc);
  const s = new EditorSession(doc);
  s.apply((d) => fillToBox(d, contentBounds(d), 512));
  expect(s.canUndo).toBe(false);
  // Off-centre on the same-size canvas: Fill recentres, so it does work.
  const moved = setTransform(doc, doc.layers[0].id, { ...IDENTITY, x: 0, y: 0 });
  expect(fillToBox(moved, contentBounds(moved), 512)).not.toBe(moved);
});

test("scaling to the size the content already has changes nothing (no undo step)", () => {
  const doc = snug(512, 300, "done");
  expect(scaleLongestSide(doc, contentBounds(doc), 512)).toBe(doc);
  const s = new EditorSession(doc);
  s.apply((d) => scaleLongestSide(d, contentBounds(d), 512));
  expect(s.canUndo).toBe(false);
  s.apply((d) => scaleLongestSide(d, contentBounds(d), 256));
  expect([s.doc.width, s.doc.height]).toEqual([256, 150]);
  s.undo();
  expect([s.doc.width, s.doc.height]).toEqual([512, 300]);
});

test("a scaled side within 1e-3 of a whole pixel snaps like the Rust merge (342.0005 -> 342)", () => {
  const doc = snug(1024, 684, "base");
  const squashed = setTransform(doc, doc.layers[0].id, {
    ...IDENTITY,
    scaleX: 0.5,
    scaleY: 342.0005 / 684,
  });
  const scaled = scaleLongestSide(squashed, contentBounds(squashed), 512);
  expect([scaled.width, scaled.height]).toEqual([512, 342]);
  expect(scaleLongestSide(scaled, contentBounds(scaled), 512)).toBe(scaled);
});

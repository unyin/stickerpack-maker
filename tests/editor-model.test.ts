// Editor document model, history, and session (ADR-0005): pure TypeScript,
// no Konva, no DOM.
import { expect, test } from "bun:test";
import type { RgbaImage } from "../src/editor/model/image";
import {
  addRasterLayer,
  addTextLayer,
  contentBounds,
  deleteLayers,
  fitToBox,
  IDENTITY,
  layerIndex,
  mergeLayers,
  moveLayer,
  newDocument,
  nextLayerId,
  placedBounds,
  setLayerImage,
  setTransform,
  type Doc,
} from "../src/editor/model/document";
import { History } from "../src/editor/model/history";
import { EditorSession } from "../src/editor/model/session";

function image(width: number, height: number, fill = 0): RgbaImage {
  return {
    width,
    height,
    pixels: new Uint8ClampedArray(width * height * 4).fill(fill),
  };
}

const names = (doc: Doc) => doc.layers.map((l) => l.name);

// ---- Document operations ----

test("a new document is sized to the imported image with one base layer", () => {
  const doc = newDocument(image(30, 20), "cat.png");
  expect([doc.width, doc.height]).toEqual([30, 20]);
  expect(doc.layers.length).toBe(1);
  const base = doc.layers[0];
  expect(base.kind).toBe("raster");
  expect(base.name).toBe("cat.png");
  expect(base.transform).toEqual(IDENTITY);
});

test("operations are pure: the input document is never changed", () => {
  const doc = newDocument(image(10, 10), "base");
  const before = JSON.stringify(doc.layers.map((l) => [l.id, l.name, l.transform]));
  addRasterLayer(doc, image(5, 5), "cutout");
  setTransform(doc, doc.layers[0].id, { ...IDENTITY, x: 3 });
  expect(JSON.stringify(doc.layers.map((l) => [l.id, l.name, l.transform]))).toBe(before);
});

test("new layers go on top with unique ids; text layers carry their text", () => {
  let doc = newDocument(image(10, 10), "base");
  doc = addRasterLayer(doc, image(5, 5), "cutout", { ...IDENTITY, x: 2, y: 3 });
  doc = addTextLayer(doc, { text: "hi", fontFamily: "Arial", fontSize: 24, color: "#ff0000" });
  expect(names(doc)).toEqual(["base", "cutout", "hi"]);
  const ids = doc.layers.map((l) => l.id);
  expect(new Set(ids).size).toBe(3);
  const text = doc.layers[2];
  expect(text.kind).toBe("text");
  if (text.kind === "text") expect(text.fontSize).toBe(24);
  expect(doc.layers[1].transform.x).toBe(2);
});

test("the id an add or merge creates equals nextLayerId of the input doc", () => {
  const base = newDocument(image(4, 4), "base");
  const raster = addRasterLayer(base, image(1, 1), "a");
  expect(raster.layers[1].id).toBe(nextLayerId(base));
  const text = addTextLayer(raster, { text: "hi", fontFamily: "sans-serif", fontSize: 24, color: "#000" });
  expect(text.layers[2].id).toBe(nextLayerId(raster));
  const merged = mergeLayers(text, [text.layers[0].id, text.layers[1].id], image(1, 1), IDENTITY);
  expect(merged.layers.map((l) => l.id)).toContain(nextLayerId(text));
  expect(nextLayerId(merged)).not.toBe(nextLayerId(text));
});

test("z-order moves clamp to the stack", () => {
  let doc = newDocument(image(4, 4), "a");
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
  let doc = newDocument(image(4, 4), "a");
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
  let doc = newDocument(image(4, 4), "a");
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
  let doc = newDocument(image(512, 512), "base"); // 512*512*4 = 1 MB
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
  const s = new EditorSession(newDocument(image(4, 4), "base"));
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
  const s = new EditorSession(newDocument(image(4, 4), "base"));
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
  const s = new EditorSession(newDocument(image(4, 4), "base"));
  const before = s.doc;
  expect(() =>
    s.apply((d) => setLayerImage(d, "nope", image(1, 1))),
  ).toThrow();
  expect(s.doc).toBe(before);
  expect(s.canUndo).toBe(false);
  expect(s.isDirty).toBe(false);
});

test("deleting layers removes them in one step and always keeps one", () => {
  let doc = newDocument(image(4, 4), "a");
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
  const s = new EditorSession(newDocument(image(4, 4), "base"));
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
  let doc = newDocument(image(300, 200), "base");
  doc = addRasterLayer(doc, image(2000, 1000), "big", { ...IDENTITY, x: -850, y: -400 });
  expect(contentBounds(doc)).toEqual({ x: -850, y: -400, width: 2000, height: 1000 });
});

test("fit scales all layers as ONE group so the content's longest side is 512, centred", () => {
  // A 300x200 photo with a 2000x1000 layer over it: the content is the
  // 2000x1000 union, so everything shrinks by 512/2000 = 0.256 together.
  let doc = newDocument(image(300, 200), "base");
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
  const small = newDocument(image(300, 200), "small");
  const grown = fitToBox(small, contentBounds(small), 512);
  expect(grown.layers[0].transform.scaleX).toBeCloseTo(512 / 300);
  expect(grown.layers[0].transform.y).toBeCloseTo((512 - 200 * (512 / 300)) / 2);
  // A rotated layer: the group is measured by its rotated box and rotation stays.
  let doc = newDocument(image(100, 100), "base");
  doc = addRasterLayer(doc, image(400, 100), "bar", { ...IDENTITY, x: 300, y: 0, rotation: 90 });
  const fitted = fitToBox(doc, contentBounds(doc), 512);
  expect(fitted.layers[1].transform.rotation).toBe(90);
  const after = contentBounds(fitted);
  expect(Math.max(after.width, after.height)).toBeCloseTo(512);
  expect(after.x + after.width / 2).toBeCloseTo(256);
  expect(after.y + after.height / 2).toBeCloseTo(256);
});

test("fitting content that already fills the box changes nothing (no undo step)", () => {
  const doc = newDocument(image(512, 512), "done");
  expect(fitToBox(doc, contentBounds(doc), 512)).toBe(doc);
  const s = new EditorSession(doc);
  s.apply((d) => fitToBox(d, contentBounds(d), 512));
  expect(s.canUndo).toBe(false);
  // Same canvas, but content smaller than the box: fit does work.
  const shrunk = setTransform(doc, doc.layers[0].id, { ...IDENTITY, scaleX: 0.5, scaleY: 0.5 });
  expect(fitToBox(shrunk, contentBounds(shrunk), 512)).not.toBe(shrunk);
});

test("fit is one undo step that restores canvas and layers", () => {
  const s = new EditorSession(newDocument(image(1000, 500), "base"));
  s.apply((d) => fitToBox(d, contentBounds(d), 512));
  expect([s.doc.width, s.doc.height]).toEqual([512, 512]);
  s.undo();
  expect([s.doc.width, s.doc.height]).toEqual([1000, 500]);
  expect(s.doc.layers[0].transform).toEqual(IDENTITY);
});

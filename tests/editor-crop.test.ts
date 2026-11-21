// Crop and the live readout (SPEC §6, SPM-6): the crop box, Crop's plan and
// its one-step application, Crop's blocker, and the readout's status for
// both constraint sets. Pure TypeScript, no Konva, no DOM.
import { expect, test } from "bun:test";
import type { RgbaImage } from "../src/editor/model/image";
import {
  constraintStatus,
  readoutText,
  startCanvas,
  STICKER,
  THUMBNAIL,
  type ConstraintSet,
} from "../src/editor/model/constraints";
import {
  addRasterLayer,
  cropBox,
  cropClipInputs,
  cropLayers,
  cropOutcome,
  IDENTITY,
  newDocument,
  NOTHING_IN_BOX,
  pixelBounds,
  placedBounds,
  planCrop,
  scaleLongestSide,
  setTransform,
  type CropAction,
  type Doc,
  type RasterLayer,
} from "../src/editor/model/document";
import { EditorSession } from "../src/editor/model/session";
import { cropBlocker } from "../src/editor/view/geometry";

function image(width: number, height: number, fill = 0): RgbaImage {
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4).fill(fill) };
}

/** An image whose pixel (x, y) is [x, y, 0, 255] (clamped to 255), so a crop shows which pixels survived. */
function coords(width: number, height: number): RgbaImage {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels.set([x, y, 0, 255], (y * width + x) * 4);
  }
  return { width, height, pixels };
}

/**
 * A stand-in for the Rust crop of an UNTRANSFORMED layer at whole pixels:
 * copy the layer's pixels under each clip rect. Rust's own tests cover the
 * transformed case (src-tauri/src/editor/crop.rs).
 */
function copyClips(doc: Doc, plan: readonly CropAction[]): Map<string, RgbaImage> {
  const out = new Map<string, RgbaImage>();
  for (const action of plan) {
    if (action.kind !== "clip") continue;
    const layer = doc.layers.find((l) => l.id === action.id) as RasterLayer;
    const { rect } = action;
    const clipped = image(rect.width, rect.height);
    for (let y = 0; y < rect.height; y++) {
      const sy = rect.y + y - layer.transform.y;
      const sx = rect.x - layer.transform.x;
      const start = (sy * layer.image.width + sx) * 4;
      clipped.pixels.set(layer.image.pixels.subarray(start, start + rect.width * 4), y * rect.width * 4);
    }
    out.set(action.id, clipped);
  }
  return out;
}

const SETS: readonly ConstraintSet[] = [STICKER, THUMBNAIL];

test("the crop box is the set's side capped at the canvas, fixed at the canvas centre, on whole pixels", () => {
  for (const set of SETS) {
    const S = set.side;
    // On the starting canvas the box is the canvas.
    expect(cropBox(startCanvas(set), S)).toEqual({ x: 0, y: 0, width: S, height: S });
    // A larger canvas: the full side, centred.
    expect(cropBox({ width: S + 40, height: S + 20 }, S)).toEqual({ x: 20, y: 10, width: S, height: S });
    // An odd difference rounds the top-left down to a whole pixel.
    expect(cropBox({ width: S + 7, height: S }, S)).toEqual({ x: 3, y: 0, width: S, height: S });
    // A smaller axis caps the box at the canvas there: never larger than the canvas.
    expect(cropBox({ width: S, height: S - 7 }, S)).toEqual({ x: 0, y: 0, width: S, height: S - 7 });
    expect(cropBox({ width: S + 9, height: S - 30 }, S)).toEqual({ x: 4, y: 0, width: S, height: S - 30 });
    expect(cropBox({ width: 3, height: 2 }, S)).toEqual({ x: 0, y: 0, width: 3, height: 2 });
  }
});

test("after Longest side the box equals the canvas, and Crop clips to exactly the canvas", () => {
  for (const set of SETS) {
    const S = set.side;
    // A wide image overflowing the starting canvas, scaled so its longest side is S.
    const doc = newDocument(coords(S * 2, S + 20), "wide", startCanvas(set));
    const scaled = scaleLongestSide(doc, placedBounds(S * 2, S + 20, doc.layers[0].transform), S);
    const box = cropBox(scaled, S);
    expect(box).toEqual({ x: 0, y: 0, width: scaled.width, height: scaled.height });
    expect(scaled.height).toBeLessThan(S);
    // Drag the image past the box's right edge, then Crop.
    const moved = setTransform(scaled, "layer-1", { ...scaled.layers[0].transform, x: 10.5 });
    const plan = planCrop(moved, box);
    expect(plan).toEqual([
      { kind: "clip", id: "layer-1", rect: { x: 10, y: 0, width: scaled.width - 10, height: scaled.height } },
    ]);
    // Clipped pixels come from Rust; their size is the plan's rect.
    const images = new Map([["layer-1", image(scaled.width - 10, scaled.height, 255)]]);
    const cropped = cropLayers(moved, plan, images);
    const layer = cropped.layers[0] as RasterLayer;
    expect(pixelBounds(placedBounds(layer.image.width, layer.image.height, layer.transform))).toEqual({
      ...box,
      x: 10,
      width: box.width - 10,
    });
    expect([cropped.width, cropped.height]).toEqual([scaled.width, scaled.height]);
    expect(cropBlocker(planCrop(cropped, cropBox(cropped, S)), cropBox(cropped, S))).toBe(
      `Everything is already inside the ${scaled.width}×${scaled.height} box.`,
    );
  }
});

test("pixelBounds rounds outwards, ignoring float noise", () => {
  expect(pixelBounds({ x: 0.5, y: -0.5, width: 2, height: 1 })).toEqual({ x: 0, y: -1, width: 3, height: 2 });
  expect(pixelBounds({ x: 1e-9, y: 9.9999999, width: 4 - 1e-9, height: 2 })).toEqual({
    x: 0,
    y: 10,
    width: 4,
    height: 2,
  });
});

test("planCrop keeps layers inside the box, clips those crossing it, removes those outside", () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };
  let doc = newDocument(image(4, 4), "inside", { width: 10, height: 10 });
  doc = setTransform(doc, "layer-1", { ...IDENTITY, x: 3, y: 3 });
  doc = addRasterLayer(doc, image(8, 4), "crossing", { ...IDENTITY, x: 6, y: -2 });
  doc = addRasterLayer(doc, image(3, 3), "outside", { ...IDENTITY, x: 10, y: 0 });
  doc = addRasterLayer(doc, image(10, 10), "exact", IDENTITY);
  expect(planCrop(doc, box)).toEqual([
    { kind: "keep", id: "layer-1" },
    { kind: "clip", id: "layer-2", rect: { x: 6, y: 0, width: 4, height: 2 } },
    { kind: "remove", id: "layer-3" },
    { kind: "keep", id: "layer-4" },
  ]);
});

test("a rotated or scaled layer is clipped to the whole pixels it covers inside the box", () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };
  // 4x2 rotated 90 degrees about its top-left at (1, 8): covers x [-1, 1), y [8, 12).
  let doc = newDocument(image(4, 2), "r", { width: 10, height: 10 });
  doc = setTransform(doc, "layer-1", { ...IDENTITY, x: 1, y: 8, rotation: 90 });
  expect(planCrop(doc, box)).toEqual([{ kind: "clip", id: "layer-1", rect: { x: 0, y: 8, width: 1, height: 2 } }]);
  // Scaled by 1.5 at (7.25, 2): covers x [7.25, 13.25), y [2, 5) -> pixels x 7..9 in the box.
  doc = setTransform(doc, "layer-1", { ...IDENTITY, x: 7.25, y: 2, scaleX: 1.5, scaleY: 1.5 });
  expect(planCrop(doc, box)).toEqual([{ kind: "clip", id: "layer-1", rect: { x: 7, y: 2, width: 3, height: 3 } }]);
});

test("Crop keeps exactly the box's pixels and never changes the canvas size", () => {
  for (const set of SETS) {
    const S = set.side;
    // An image larger than the box on every side, at its native size, centred.
    const doc = newDocument(coords(S + 30, S + 11), "big", startCanvas(set));
    const box = cropBox(doc, S);
    const plan = planCrop(doc, box);
    expect(plan).toEqual([{ kind: "clip", id: "layer-1", rect: box }]);
    const cropped = cropLayers(doc, plan, copyClips(doc, plan));
    expect([cropped.width, cropped.height]).toEqual([doc.width, doc.height]);
    const layer = cropped.layers[0] as RasterLayer;
    // The result covers the overlay exactly...
    expect(pixelBounds(placedBounds(layer.image.width, layer.image.height, layer.transform))).toEqual(box);
    expect(layer.transform).toEqual({ ...IDENTITY, x: box.x, y: box.y });
    // ...and holds the source pixels under it: the image started at (-15, -6).
    const t = doc.layers[0].transform;
    const at = (x: number, y: number) => Array.from(layer.image.pixels.subarray((y * S + x) * 4, (y * S + x) * 4 + 4));
    const c = (v: number) => Math.min(v, 255);
    expect(at(0, 0)).toEqual([box.x - t.x, box.y - t.y, 0, 255]);
    const m = S / 2;
    expect(at(m, m)).toEqual([c(box.x + m - t.x), c(box.y + m - t.y), 0, 255]);
    expect(at(S - 1, S - 1)).toEqual([c(box.x + S - 1 - t.x), c(box.y + S - 1 - t.y), 0, 255]);
    // Crop again: nothing is outside any more.
    expect(planCrop(cropped, cropBox(cropped, S)).every((a) => a.kind === "keep")).toBe(true);
  }
});

test("Crop keeps ids, names and stack order, and drops layers entirely outside the box", () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };
  let doc = newDocument(image(12, 12, 1), "base", { width: 10, height: 10 });
  doc = setTransform(doc, "layer-1", { ...IDENTITY, x: -1, y: -1 });
  doc = addRasterLayer(doc, image(2, 2, 2), "gone", { ...IDENTITY, x: 20, y: 20 });
  doc = addRasterLayer(doc, image(2, 2, 3), "kept", { ...IDENTITY, x: 4, y: 4 });
  const plan = planCrop(doc, box);
  const cropped = cropLayers(doc, plan, copyClips(doc, plan));
  expect(cropped.layers.map((l) => [l.id, l.name])).toEqual([
    ["layer-1", "base"],
    ["layer-3", "kept"],
  ]);
  expect(cropped.layers[1]).toBe(doc.layers[2]); // untouched layers are reused
  expect(cropped.nextId).toBe(doc.nextId);
});

test("cropLayers refuses a plan that would leave no layers, or pixels of the wrong size", () => {
  const doc = newDocument(image(2, 2), "far", { width: 10, height: 10 });
  const away = setTransform(doc, "layer-1", { ...IDENTITY, x: 50 });
  const plan = planCrop(away, cropBox(away, 10));
  expect(plan).toEqual([{ kind: "remove", id: "layer-1" }]);
  expect(() => cropLayers(away, plan, new Map())).toThrow(NOTHING_IN_BOX);
  const edge = setTransform(doc, "layer-1", { ...IDENTITY, x: 9 });
  const clip = planCrop(edge, cropBox(edge, 10));
  expect(() => cropLayers(edge, clip, new Map([["layer-1", image(2, 2)]]))).toThrow("do not match");
  expect(() => cropLayers(edge, [], new Map())).toThrow("does not match the document");
  // Nothing outside: the same document (no undo step).
  const inside = planCrop(doc, cropBox(doc, 10));
  expect(cropLayers(doc, inside, new Map())).toBe(doc);
});

test("cropBlocker: disabled when nothing is outside the box, or nothing is inside it", () => {
  for (const set of SETS) {
    const S = set.side;
    const doc = newDocument(image(S, S), "fits", startCanvas(set));
    const box = cropBox(doc, S);
    expect(cropBlocker(planCrop(doc, box), box)).toBe(`Everything is already inside the ${S}×${S} box.`);
    const over = setTransform(doc, "layer-1", { ...IDENTITY, x: 1 });
    expect(cropBlocker(planCrop(over, box), box)).toBeNull();
    const away = setTransform(doc, "layer-1", { ...IDENTITY, x: S * 3 });
    expect(cropBlocker(planCrop(away, box), box)).toBe(NOTHING_IN_BOX);
    // The reason names the actual (capped) box size.
    const short = { ...doc, height: S - 10 };
    const capped = cropBox(short, S);
    expect(cropBlocker(planCrop(doc, capped), capped)).toBeNull();
    const fits = setTransform(short, "layer-1", { ...IDENTITY, scaleY: (S - 10) / S });
    expect(cropBlocker(planCrop(fits, capped), capped)).toBe(`Everything is already inside the ${S}×${S - 10} box.`);
  }
});

test("Crop is one undo step; undo and redo restore the layers and keep the canvas", () => {
  const S = STICKER.side;
  let doc = newDocument(coords(S + 20, S), "base", startCanvas(STICKER));
  doc = addRasterLayer(doc, image(4, 4), "stray", { ...IDENTITY, x: -50, y: 0 });
  const session = new EditorSession(doc);
  session.select("layer-2");
  const before = session.doc;
  const plan = planCrop(before, cropBox(before, S));
  session.apply((d) => cropLayers(d, plan, copyClips(d, plan)));
  const after = session.doc;
  expect(after.layers.map((l) => l.id)).toEqual(["layer-1"]);
  expect(session.selection).toEqual([]); // the discarded layer leaves the selection
  expect([after.width, after.height]).toEqual([before.width, before.height]);
  session.undo();
  expect(session.doc).toBe(before);
  session.redo();
  expect(session.doc).toBe(after);
});

test("constraintStatus: Sticker mode needs the longest side exactly the sticker side", () => {
  const S = STICKER.side;
  expect(constraintStatus({ width: S, height: S }, STICKER)).toEqual({ ok: true, off: [] });
  expect(constraintStatus({ width: S - 100, height: S }, STICKER).ok).toBe(true);
  expect(constraintStatus({ width: S + 88, height: 400 }, STICKER)).toEqual({
    ok: false,
    off: [{ side: "longest side", by: 88 }],
  });
  expect(constraintStatus({ width: 300, height: S - 12 }, STICKER)).toEqual({
    ok: false,
    off: [{ side: "longest side", by: -12 }],
  });
});

test("constraintStatus: Thumbnail mode needs exactly side x side", () => {
  const T = THUMBNAIL.side;
  expect(constraintStatus({ width: T, height: T }, THUMBNAIL)).toEqual({ ok: true, off: [] });
  // A longest side of T is not enough for a thumbnail.
  expect(constraintStatus({ width: T, height: T - 30 }, THUMBNAIL)).toEqual({
    ok: false,
    off: [{ side: "height", by: -30 }],
  });
  expect(constraintStatus({ width: T + 20, height: T + 5 }, THUMBNAIL)).toEqual({
    ok: false,
    off: [
      { side: "width", by: 20 },
      { side: "height", by: 5 },
    ],
  });
});

test("readoutText names the canvas size and how far off it is, per set", () => {
  const S = STICKER.side;
  const T = THUMBNAIL.side;
  expect(readoutText({ width: S, height: 340 }, STICKER)).toBe(`${S}×340 px · sticker size OK (longest side ${S})`);
  expect(readoutText({ width: S + 88, height: 400 }, STICKER)).toBe(
    `${S + 88}×400 px · needs longest side ${S}: 88 px over`,
  );
  expect(readoutText({ width: 200, height: S - 12 }, STICKER)).toBe(
    `200×${S - 12} px · needs longest side ${S}: 12 px under`,
  );
  expect(readoutText({ width: T, height: T }, THUMBNAIL)).toBe(`${T}×${T} px · thumbnail size OK (${T}×${T})`);
  expect(readoutText({ width: T + 20, height: T - 5 }, THUMBNAIL)).toBe(
    `${T + 20}×${T - 5} px · needs ${T}×${T}: width 20 px over, height 5 px under`,
  );
});

test("the readout follows undo and redo of a canvas change", () => {
  const S = STICKER.side;
  const doc = newDocument(image(S * 2, S), "wide", { width: S * 2, height: S });
  const session = new EditorSession(doc);
  const seen: string[] = [];
  session.subscribe(() => seen.push(readoutText(session.doc, STICKER)));
  session.apply((d) => scaleLongestSide(d, placedBounds(S * 2, S, d.layers[0].transform), S));
  session.undo();
  session.redo();
  expect(seen).toEqual([
    `${S}×${S / 2} px · sticker size OK (longest side ${S})`,
    `${S * 2}×${S} px · needs longest side ${S}: ${S} px over`,
    `${S}×${S / 2} px · sticker size OK (longest side ${S})`,
  ]);
});

/** A 20x2 strip turned 45 degrees (running down and to the right) from (x, y). */
function strip(x: number, y: number): Doc {
  const doc = newDocument(coords(20, 2), "strip", { width: 10, height: 10 });
  return setTransform(doc, "layer-1", { ...IDENTITY, x, y, rotation: 45 });
}

const BOX10 = { x: 0, y: 0, width: 10, height: 10 };

test("a turned layer whose bounding box overlaps the box but whose rectangle does not is removed", () => {
  // Along x - y = 14..11.2 from (6, -8) to (20, 6): its bounding box covers
  // part of the box, the strip itself stays beyond the box's corner (x - y <= 10).
  const doc = strip(6, -8);
  const b = placedBounds(20, 2, doc.layers[0].transform);
  expect(b.x).toBeLessThan(BOX10.x + BOX10.width);
  expect(b.y).toBeLessThan(BOX10.y + BOX10.height);
  expect(b.x + b.width).toBeGreaterThan(BOX10.x);
  expect(b.y + b.height).toBeGreaterThan(BOX10.y);
  expect(planCrop(doc, BOX10)).toEqual([{ kind: "remove", id: "layer-1" }]);
});

test("with only such layers Crop is blocked with NOTHING_IN_BOX", () => {
  const doc = strip(6, -8);
  const plan = planCrop(doc, BOX10);
  expect(cropOutcome(plan)).toBe("nothing-inside");
  expect(cropBlocker(plan, BOX10)).toBe(NOTHING_IN_BOX);
  expect(() => cropLayers(doc, plan, new Map())).toThrow(NOTHING_IN_BOX);
});

test("a turned layer that truly crosses the box is still clipped", () => {
  // The same strip started 4 px further left reaches x - y = 10 .. 8.6.
  const plan = planCrop(strip(2, -8), BOX10);
  expect(plan.map((a) => a.kind)).toEqual(["clip"]);
  const clip = plan[0] as Extract<CropAction, { kind: "clip" }>;
  expect(clip.rect.x + clip.rect.width).toBeLessThanOrEqual(10);
  expect(clip.rect.y + clip.rect.height).toBeLessThanOrEqual(10);
});

test("a crossing layer whose part in the box is transparent is kept, like a transparent layer inside the box", () => {
  let doc = newDocument(coords(12, 12), "base", { width: 10, height: 10 });
  doc = setTransform(doc, "layer-1", { ...IDENTITY, x: -1, y: -1 });
  doc = addRasterLayer(doc, coords(4, 4), "ghost", { ...IDENTITY, x: 8, y: 8 });
  const plan = planCrop(doc, BOX10);
  expect(plan.map((a) => a.kind)).toEqual(["clip", "clip"]);
  const images = copyClips(doc, plan);
  const ghost = plan[1] as Extract<CropAction, { kind: "clip" }>;
  images.set("layer-2", image(ghost.rect.width, ghost.rect.height)); // Rust drew nothing
  expect(cropLayers(doc, plan, images).layers.map((l) => l.id)).toEqual(["layer-1", "layer-2"]);
  // Even when it is the only layer.
  const only = newDocument(image(4, 4, 1), "only", { width: 10, height: 10 });
  const edge = setTransform(only, "layer-1", { ...IDENTITY, x: 8 });
  const edgePlan = planCrop(edge, BOX10);
  const out = cropLayers(edge, edgePlan, new Map([["layer-1", image(2, 4)]]));
  expect(out.layers.map((l) => l.id)).toEqual(["layer-1"]);
});

test("cropOutcome and cropClipInputs summarise a plan", () => {
  let doc = newDocument(coords(4, 4), "in", { width: 10, height: 10 });
  expect(cropOutcome(planCrop(doc, BOX10))).toBe("nothing-outside");
  doc = addRasterLayer(doc, coords(4, 4), "edge", { ...IDENTITY, x: 8, y: 0 });
  doc = addRasterLayer(doc, coords(4, 4), "far", { ...IDENTITY, x: 30, y: 0 });
  const plan = planCrop(doc, BOX10);
  expect(cropOutcome(plan)).toBe("crop");
  const inputs = cropClipInputs(doc, plan);
  expect(inputs.map((i) => i.id)).toEqual(["layer-2"]);
  expect(inputs[0].image).toBe((doc.layers[1] as RasterLayer).image);
  expect(inputs[0].transform).toBe(doc.layers[1].transform);
  expect(inputs[0].clip).toEqual({ x: 8, y: 0, width: 2, height: 4 });
});

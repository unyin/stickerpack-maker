// Effects (SPEC §6, SPM-8): outline and fuzzy glow targeting, baking a
// result into the document, the live preview's scheduling, and the
// warp/bulge brush's pixel maths. Pure TypeScript, no Konva, no DOM; the
// Rust effect is stood in for by plain pixel buffers.
import { expect, test } from "bun:test";
import type { RgbaImage } from "../src/editor/model/image";
import {
  addRasterLayer,
  addTextLayer,
  docToLocal,
  IDENTITY,
  localToDoc,
  newDocument,
  setTransform,
  type Doc,
  type TextRender,
} from "../src/editor/model/document";
import {
  applyEffectResult,
  effectBasis,
  escDiscardsEffect,
  nextEffectBasis,
  effectTarget,
  effectTextNotice,
  GLOW_DEFAULTS,
  GLOW_SOFTNESS,
  glowEffect,
  outlineTextPatch,
  OUTLINE_DEFAULTS,
  OUTLINE_WIDTH,
  outlineEffect,
  typedSliderValue,
  warpTarget,
  type Effect,
  type EffectBasis,
  type EffectResult,
} from "../src/editor/model/effects";
import { bulgeDab, moveWarpGesture, restoreRect, startWarpGesture, warpAmount, warpReadout, WARP_DEFAULTS, WARP_RADIUS } from "../src/editor/model/warp";
import { EffectPreview, type PreviewRequest } from "../src/editor/view/effect-preview";
import { EditorSession } from "../src/editor/model/session";
import { DEFAULT_OUTLINE_COLOR } from "../src/editor/model/text";

function solid(width: number, height: number, rgba = [255, 0, 0, 255]): RgbaImage {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
  return { width, height, pixels };
}

const CANVAS = { width: 512, height: 512 };

function render(width = 40, height = 20): TextRender {
  return { image: solid(width, height), metrics: { originX: 0, originY: 0, ascent: 16, descent: 4, lineHeight: 20 } };
}

function threeLayers(): Doc {
  let doc = newDocument(solid(100, 100), "Base", CANVAS);
  doc = addRasterLayer(doc, solid(10, 10), "Top", { ...IDENTITY, x: 5, y: 5 });
  return addTextLayer(doc, { text: "Hi", fontFamily: "Impact", fontSize: 64, color: "#000000", outline: null }, render());
}

// ---- Targeting (SPEC §6: the selected layer, else the base image) ----

test("an effect targets the one selected layer, else the base image", () => {
  const doc = threeLayers();
  expect(effectTarget(doc, ["layer-2"])).toEqual({ id: "layer-2" });
  expect(effectTarget(doc, [])).toEqual({ id: "layer-1" });
  expect(effectTarget(doc, ["layer-3"])).toEqual({ id: "layer-3" }); // text is a target: Glow rasterises it on Apply, Outline restyles it (SPM-18)
  const both = effectTarget(doc, ["layer-1", "layer-2"]);
  expect("blocker" in both && both.blocker).toContain("one layer");
});

test("warp paints on the selected image layer, else the base image; never on text", () => {
  const doc = threeLayers();
  expect(warpTarget(doc, ["layer-2"])).toEqual({ id: "layer-2" });
  expect(warpTarget(doc, [])).toEqual({ id: "layer-1" });
  const text = warpTarget(doc, ["layer-3"]);
  expect("blocker" in text && text.blocker).toContain("Text layers can't be warped");
  const both = warpTarget(doc, ["layer-1", "layer-2"]);
  expect("blocker" in both && both.blocker).toContain("one layer");
});

test("only a change of target or document discards an effect tool; re-picking the target does not", () => {
  const doc = threeLayers();
  const base = effectBasis(doc, []); // nothing selected: the base image is the target
  expect(nextEffectBasis(base, doc, [])).toEqual(base);
  expect(nextEffectBasis(base, doc, ["layer-1"])).toEqual(base); // clicking the base image itself
  expect(nextEffectBasis(base, doc, ["layer-2"])).toBe("discard"); // another layer
  expect(nextEffectBasis(base, doc, ["layer-1", "layer-2"])).toBe("discard"); // no single target any more
  expect(nextEffectBasis(base, { ...doc }, [])).toBe("discard"); // undo/redo or any edit
  const top = effectBasis(doc, ["layer-2"]);
  expect(nextEffectBasis(top, doc, ["layer-2"])).toEqual(top); // re-clicking the selected layer
  expect(nextEffectBasis(top, doc, [])).toBe("discard"); // deselecting: the base image becomes the target
});

test("with no target yet (several selected), choosing one layer makes it the target instead of discarding", () => {
  const doc = threeLayers();
  const blocked = effectBasis(doc, ["layer-1", "layer-2"]);
  expect(blocked.targetId).toBeNull();
  expect(nextEffectBasis(blocked, doc, ["layer-2", "layer-3"])).toEqual({ doc, targetId: null });
  const chosen = nextEffectBasis(blocked, doc, ["layer-2"]);
  expect(chosen).toEqual({ doc, targetId: "layer-2" });
  // From then on, picking another layer is a discard as usual.
  expect(nextEffectBasis(chosen as EffectBasis, doc, ["layer-3"])).toBe("discard");
});

test("an Esc that deselects ends an Outline/Glow tool; Esc with nothing selected does not", () => {
  // CMT-243 restored (owner decision 2026-11-23): a deselect is a discard
  // even when the target survives it — the base image selected, clearing the
  // selection still targets the base — which nextEffectBasis's re-pick
  // shortcut would otherwise swallow.
  expect(escDiscardsEffect("outline", ["layer-1"])).toBe(true); // the base image itself
  expect(escDiscardsEffect("glow", ["layer-2"])).toBe(true);
  expect(escDiscardsEffect("glow", ["layer-1", "layer-2"])).toBe(true); // several selected, no target yet
  expect(escDiscardsEffect("outline", [])).toBe(false); // nothing selected: Esc does nothing
  expect(escDiscardsEffect("warp", ["layer-1"])).toBe(false); // Warp keeps today's Esc
  expect(escDiscardsEffect("erase", ["layer-1"])).toBe(false);
  expect(escDiscardsEffect("move", ["layer-1"])).toBe(false);
  // The picking rules are untouched: re-picking the target keeps the tool.
  const doc = threeLayers();
  const base = effectBasis(doc, []);
  expect(nextEffectBasis(base, doc, ["layer-1"])).toEqual(base);
});

// ---- Settings on the wire ----

test("a typed slider entry clamps into its range; anything not a whole number reverts", () => {
  // The field's commit rule (owner decision 2026-11-23): a whole number
  // lands as dragging the slider there would; empty or junk text reverts.
  expect(typedSliderValue("55", OUTLINE_WIDTH)).toBe(55);
  expect(typedSliderValue(" 55 ", OUTLINE_WIDTH)).toBe(55);
  expect(typedSliderValue("9999", OUTLINE_WIDTH)).toBe(OUTLINE_WIDTH.max);
  expect(typedSliderValue("0", OUTLINE_WIDTH)).toBe(OUTLINE_WIDTH.min);
  expect(typedSliderValue("-5", GLOW_SOFTNESS)).toBe(GLOW_SOFTNESS.min);
  expect(typedSliderValue("", OUTLINE_WIDTH)).toBeNull();
  expect(typedSliderValue("abc", OUTLINE_WIDTH)).toBeNull();
  expect(typedSliderValue("3.5", OUTLINE_WIDTH)).toBeNull();
  expect(typedSliderValue("12px", OUTLINE_WIDTH)).toBeNull();
});

test("settings become the wire effect: percentages as fractions", () => {
  expect(outlineEffect({ color: "#ffffff", width: 8 })).toEqual({ kind: "outline", color: "#ffffff", width: 8 });
  expect(glowEffect({ color: "#ffeb3b", radius: 24, softness: 70, opacity: 80 })).toEqual({
    kind: "glow",
    color: "#ffeb3b",
    radius: 24,
    softness: 0.7,
    opacity: 0.8,
  });
  expect(OUTLINE_DEFAULTS.width).toBeGreaterThan(0);
  expect(GLOW_DEFAULTS.radius).toBeGreaterThan(0);
});

// ---- Apply bakes the result (CMT-183: ONE undo step) ----

test("applying an effect replaces the layer's pixels and transform, keeping its id, name and place", () => {
  const doc = threeLayers();
  const result: EffectResult = { image: solid(14, 14), transform: { ...IDENTITY, x: 3, y: 3 } };
  const next = applyEffectResult(doc, "layer-2", result);
  expect(next.layers.map((l) => l.id)).toEqual(["layer-1", "layer-2", "layer-3"]);
  const layer = next.layers[1];
  expect(layer.kind).toBe("raster");
  expect(layer.name).toBe("Top");
  expect(layer.transform).toEqual(result.transform);
  expect(layer.kind === "raster" && layer.image).toBe(result.image);
  expect(next.layers[0]).toBe(doc.layers[0]); // untouched layers are shared
  expect(next.nextId).toBe(doc.nextId);
});

test("an effect on a text layer turns it into an image layer, with a neutral note (glow only)", () => {
  const doc = threeLayers();
  const next = applyEffectResult(doc, "layer-3", { image: solid(46, 26), transform: { ...IDENTITY, x: -3, y: -3 } });
  expect(next.layers[2].kind).toBe("raster");
  expect(next.layers[2].name).toBe("Hi");
  expect(effectTextNotice(doc.layers[2], "glow")).toBe("The text layer was converted to an image for the glow.");
  expect(effectTextNotice(doc.layers[2], "outline")).toBeNull(); // SPM-18: Outline restyles text, never converts
  expect(effectTextNotice(doc.layers[1], "glow")).toBeNull();
});

test("the Outline tool on a text layer is a style patch; Glow and raster targets are not (SPM-18)", () => {
  const doc = threeLayers();
  const text = doc.layers[2];
  const raster = doc.layers[1];
  if (text.kind !== "text") throw new Error("not text");
  expect(outlineTextPatch(outlineEffect(OUTLINE_DEFAULTS), text)).toEqual({
    outline: { color: OUTLINE_DEFAULTS.color, width: OUTLINE_DEFAULTS.width },
    layer: text,
  });
  expect(outlineTextPatch(glowEffect(GLOW_DEFAULTS), text)).toBeNull();
  expect(outlineTextPatch(outlineEffect(OUTLINE_DEFAULTS), raster)).toBeNull();
});

test("Apply is ONE undo step, and undo brings the layer back exactly", () => {
  const session = new EditorSession(threeLayers());
  const before = session.doc;
  session.apply("Edit", (d) => applyEffectResult(d, "layer-1", { image: solid(120, 120), transform: { ...IDENTITY, x: 196, y: 196 } }));
  expect(session.isDirty).toBe(true);
  session.undo();
  expect(session.doc).toBe(before);
  expect(session.isDirty).toBe(false);
});

// ---- Live preview (CMT-183, CMT-185, CMT-186) ----

/** A compute stand-in whose calls resolve only when the test says so. */
function controlledCompute() {
  const calls: { req: PreviewRequest; resolve: (r: string) => void; reject: (e: Error) => void }[] = [];
  const compute = (req: PreviewRequest) =>
    new Promise<string>((resolve, reject) => calls.push({ req, resolve, reject }));
  return { calls, compute };
}

const outline8: Effect = { kind: "outline", color: "#ffffff", width: 8 };
const outline9: Effect = { kind: "outline", color: "#ffffff", width: 9 };
const outline10: Effect = { kind: "outline", color: "#ffffff", width: 10 };
const flush = () => new Promise((r) => setTimeout(r, 0));

test("the preview shows the latest settings, skipping ones superseded while a render ran", async () => {
  const { calls, compute } = controlledCompute();
  const shown: (string | null)[] = [];
  const preview = new EffectPreview(compute, (_req, result) => shown.push(result));
  const doc = threeLayers();
  preview.request({ doc, layerId: "layer-1", effect: outline8 });
  preview.request({ doc, layerId: "layer-1", effect: outline9 }); // dragging the slider
  preview.request({ doc, layerId: "layer-1", effect: outline10 });
  expect(calls.length).toBe(1); // one render at a time
  calls[0].resolve("w8");
  await flush();
  expect(shown).toEqual([]); // stale: not shown
  expect(calls.length).toBe(2);
  expect(calls[1].req.effect).toEqual(outline10); // 9 was skipped
  calls[1].resolve("w10");
  await flush();
  expect(shown).toEqual(["w10"]);
  // The same request again changes nothing.
  preview.request({ doc, layerId: "layer-1", effect: outline10 });
  expect(calls.length).toBe(2);
});

test("a new layer or document discards the preview at once; new settings keep it until replaced", async () => {
  const { calls, compute } = controlledCompute();
  const shown: (string | null)[] = [];
  const preview = new EffectPreview(compute, (_req, result) => shown.push(result));
  const doc = threeLayers();
  preview.request({ doc, layerId: "layer-1", effect: outline8 });
  calls[0].resolve("a");
  await flush();
  preview.request({ doc, layerId: "layer-1", effect: outline9 });
  expect(shown).toEqual(["a"]); // still showing the old one while the new renders
  calls[1].resolve("b");
  await flush();
  preview.request({ doc, layerId: "layer-2", effect: outline9 }); // another layer
  expect(shown).toEqual(["a", "b", null]);
  calls[2].resolve("c");
  await flush();
  preview.request({ doc: { ...doc }, layerId: "layer-2", effect: outline9 }); // undo/redo or any edit
  expect(shown.at(-1)).toBeNull();
  preview.request(null); // tool switched or Editor closed
  calls[3].resolve("late");
  await flush();
  expect(shown.at(-1)).toBeNull(); // a late result for a discarded request never shows
});

test("result() gives Apply exactly the preview it shows, or waits for the one being drawn", async () => {
  const { calls, compute } = controlledCompute();
  const preview = new EffectPreview(compute, () => {});
  const doc = threeLayers();
  const req = { doc, layerId: "layer-1", effect: outline8 };
  preview.request(req);
  const pending = preview.result(req);
  calls[0].resolve("r");
  expect(await pending).toBe("r");
  expect(await preview.result(req)).toBe("r"); // cached: no second render
  expect(calls.length).toBe(1);
  // A request that is not the wanted one is drawn on demand.
  const other = { doc, layerId: "layer-2", effect: outline8 };
  const drawn = preview.result(other);
  await flush();
  calls[1].resolve("o");
  expect(await drawn).toBe("o");
});

test("a failed render is reported and not retried until the request changes", async () => {
  const { calls, compute } = controlledCompute();
  const errors: string[] = [];
  const preview = new EffectPreview(compute, () => {}, (e) => errors.push(String(e)));
  const doc = threeLayers();
  preview.request({ doc, layerId: "layer-1", effect: outline8 });
  calls[0].reject(new Error("too large"));
  await flush();
  expect(errors).toEqual(["Error: too large"]);
  preview.request({ doc, layerId: "layer-1", effect: outline8 });
  expect(calls.length).toBe(1);
  preview.request({ doc, layerId: "layer-1", effect: outline9 });
  expect(calls.length).toBe(2);
});

// ---- Warp / bulge (SPEC §6: magnify in place, the image stays one piece) ----

/** Pixel (x, y) is [x, y, 0, 255]: where each pixel came from is readable. */
function coords(width: number, height: number): RgbaImage {
  const image = solid(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.pixels.set([x, y, 0, 255], (y * width + x) * 4);
  return image;
}

test("a bulge magnifies around its centre and leaves pixels outside its radius alone", () => {
  const image = coords(64, 64);
  const before = image.pixels.slice();
  const dirty = bulgeDab(image, 32, 32, 10, 0.5);
  expect(dirty).toEqual({ x: 22, y: 22, width: 20, height: 20 });
  // Outside the circle: untouched, exactly.
  const at = (x: number, y: number) => [...image.pixels.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
  expect(at(10, 10)).toEqual([10, 10, 0, 255]);
  expect(at(32, 21)).toEqual([...before.slice((21 * 64 + 32) * 4, (21 * 64 + 32) * 4 + 4)]);
  // Near the centre, pixels come from closer to the centre (magnified):
  // the pixel 4 px right of it shows one that lay nearer.
  const [sx] = at(36, 32);
  expect(sx).toBeGreaterThanOrEqual(33);
  expect(sx).toBeLessThan(36);
  // The image keeps its size: one piece.
  expect(image.pixels.length).toBe(64 * 64 * 4);
});

test("a bulge keeps opacity on transparent surroundings and never folds over", () => {
  const image = solid(40, 40, [0, 0, 0, 0]);
  for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) image.pixels.set([0, 0, 255, 255], (y * 40 + x) * 4);
  bulgeDab(image, 20, 20, 12, warpAmount(100));
  // The square grew: a pixel that was transparent is now blue.
  expect([...image.pixels.slice((20 * 40 + 25) * 4, (20 * 40 + 25) * 4 + 4)]).toEqual([0, 0, 255, 255]);
  // No dark fringe: partly transparent pixels keep the square's colour.
  for (let i = 0; i < image.pixels.length; i += 4) {
    if (image.pixels[i + 3] > 0) expect(image.pixels[i + 2]).toBe(255);
  }
  // Monotonic: the profile maps distance d to d * m(d), increasing, at full strength too.
  expect(warpAmount(100)).toBeLessThan(1);
});

test("a dab past the image edge only touches the image", () => {
  const image = coords(20, 20);
  expect(bulgeDab(image, -5, 10, 8, 0.5)).toEqual({ x: 0, y: 2, width: 3, height: 16 });
  expect(bulgeDab(image, -50, 10, 8, 0.5)).toBeNull();
});

test("re-placing a bulge restores the original first, so bulges never stack", () => {
  const original = coords(64, 64);
  const working = { ...original, pixels: original.pixels.slice() };
  const first = bulgeDab(working, 30, 30, 12, 0.6)!;
  restoreRect(working, original, first);
  expect(working.pixels).toEqual(original.pixels);
  bulgeDab(working, 30, 30, 20, 0.3);
  const fresh = { ...original, pixels: original.pixels.slice() };
  bulgeDab(fresh, 30, 30, 20, 0.3);
  expect(working.pixels).toEqual(fresh.pixels);
});

test("a click is one bulge with the slider values", () => {
  const g = startWarpGesture({ x: 100, y: 100 }, { strength: 30, radius: 60 }, false);
  expect([g.radius, g.strength, g.mode, g.dragged]).toEqual([60, 30, "radius", false]);
  // Within the drag slop (4 screen px at 100%) it stays a click.
  const still = moveWarpGesture(g, { x: 103, y: 100 }, false, 1);
  expect([still.radius, still.dragged]).toEqual([60, false]);
  expect(warpAmount(0)).toBe(0);
  expect(warpAmount(WARP_DEFAULTS.strength)).toBeGreaterThan(0);
});

test("a press-drag sets the radius to the pointer's distance from the press point", () => {
  let g = startWarpGesture({ x: 100, y: 100 }, { strength: 30, radius: 60 }, false);
  g = moveWarpGesture(g, { x: 100, y: 140 }, false, 1);
  expect([g.radius, g.strength, g.dragged]).toEqual([40, 30, true]);
  expect(g.center).toEqual({ x: 100, y: 100 }); // the bulge stays where it was pressed
  // Clamped to the slider's range.
  expect(moveWarpGesture(g, { x: 101, y: 100 }, false, 1).radius).toBe(WARP_RADIUS.min);
  expect(moveWarpGesture(g, { x: 900, y: 100 }, false, 1).radius).toBe(WARP_RADIUS.max);
  expect(warpReadout(g)).toBe("Radius 40 px");
});

test("holding Shift switches the drag to strength from the pointer's vertical movement, radius frozen; releasing continues the radius", () => {
  let g = startWarpGesture({ x: 0, y: 0 }, { strength: 30, radius: 60 }, false);
  g = moveWarpGesture(g, { x: 50, y: 0 }, false, 1); // radius 50
  g = moveWarpGesture(g, { x: 50, y: 0 }, true, 1); // Shift down: nothing jumps
  expect([g.mode, g.radius, g.strength]).toEqual(["strength", 50, 30]);
  g = moveWarpGesture(g, { x: 70, y: 0 }, true, 1); // horizontal only: strength follows y, not distance
  expect([g.radius, g.strength]).toEqual([50, 30]);
  g = moveWarpGesture(g, { x: 70, y: -20 }, true, 1); // 20 px up = +10%
  expect([g.radius, g.strength]).toEqual([50, 40]);
  expect(warpReadout(g)).toBe("Strength 40%");
  g = moveWarpGesture(g, { x: 70, y: 10 }, true, 1); // 10 px below the swap's y: 30 - 5
  expect(g.strength).toBe(25);
  expect(moveWarpGesture(g, { x: 70, y: 500 }, true, 1).strength).toBe(1); // clamped below
  expect(moveWarpGesture(g, { x: 70, y: -500 }, true, 1).strength).toBe(100); // clamped above
  g = moveWarpGesture(g, { x: 70, y: 10 }, false, 1); // Shift up: back to radius, from 50
  expect([g.mode, g.radius, g.strength]).toEqual(["radius", 50, 25]);
  g = moveWarpGesture(g, { x: 30, y: 0 }, false, 1); // the radius continues from its frozen value
  expect([g.radius, g.strength]).toEqual([9, 25]);
});

test("strength follows vertical movement at any zoom, up increasing", () => {
  // The pointer's y is document px; the zoom converts it to the screen px
  // the rate is set in, so the strength changes the same per screen px.
  let g = startWarpGesture({ x: 0, y: 0 }, { strength: 30, radius: 60 }, true);
  expect(g.mode).toBe("strength");
  g = moveWarpGesture(g, { x: 10, y: -5 }, true, 2); // 5 doc px = 10 screen px up: +5%
  expect([g.radius, g.strength, g.dragged]).toEqual([60, 35, true]);
  g = moveWarpGesture(g, { x: 10, y: 5 }, true, 0.5); // 5 doc px down at 50%: 30 - 1.25 -> 29
  expect(g.strength).toBe(29);
});

test("docToLocal inverts localToDoc for a turned and scaled layer", () => {
  const t = { x: 10, y: -4, scaleX: 2, scaleY: 2, rotation: 30 };
  const p = docToLocal(t, localToDoc(t, 7, 3));
  expect(p.x).toBeCloseTo(7, 9);
  expect(p.y).toBeCloseTo(3, 9);
});

test("the Outline tool's document-px width lands as the style's own px on a scaled layer (SPM-18)", () => {
  // A 2x-scaled text layer: the bar's 8 document px is 4 px at scale 1 —
  // the same on-screen reach the pixel effect's 8 would give, so the two
  // tools keep one meaning for their width.
  const doc = threeLayers();
  const scaled = setTransform(doc, "layer-3", { ...IDENTITY, x: 10, y: 10, scaleX: 2, scaleY: 2, rotation: 0 });
  const patch = outlineTextPatch(outlineEffect({ ...OUTLINE_DEFAULTS, width: 8 }), scaled.layers[2]);
  expect(patch?.outline).toEqual({ color: OUTLINE_DEFAULTS.color, width: 4 });

  // A 1.5x-scaled layer rounds into the whole-px domain: 8 / 1.5 -> 5.
  const odd = setTransform(doc, "layer-3", { ...IDENTITY, x: 10, y: 10, scaleX: 1.5, scaleY: 1.5, rotation: 0 });
  const rounded = outlineTextPatch(outlineEffect({ ...OUTLINE_DEFAULTS, width: 8 }), odd.layers[2]);
  expect(rounded?.outline).toEqual({ color: OUTLINE_DEFAULTS.color, width: 5 });
  // A layer scaled to nothing is not a text restyle: the patch yields and
  // the pixel path refuses it (effects.rs `layer_px`'s own message).
  const flat = setTransform(doc, "layer-3", { ...IDENTITY, x: 10, y: 10, scaleX: 0, scaleY: 0, rotation: 0 });
  expect(outlineTextPatch(outlineEffect(OUTLINE_DEFAULTS), flat.layers[2])).toBeNull();
});

test("the text style's default outline colour is the effect's (SPM-18)", () => {
  expect(DEFAULT_OUTLINE_COLOR).toBe(OUTLINE_DEFAULTS.color);
});

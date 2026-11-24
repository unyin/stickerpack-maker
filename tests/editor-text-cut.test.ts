// Text layers, Crop of text, cut and the cut selection (SPEC §6, SPM-9):
// the model and view decisions. Pure TypeScript, no Konva, no DOM; the Rust
// side (rendering, cutting) is stood in for by plain pixel buffers.
import { expect, test } from "bun:test";
import limits from "../src/shared/limits.json";
import type { RgbaImage } from "../src/editor/model/image";
import { STICKER, TEXT_FONT_SIZE, TEXT_OUTLINE_WIDTH } from "../src/editor/model/constraints";
import {
  addRasterLayer,
  addTextLayer,
  anchoredTransform,
  contentBounds,
  cropBox,
  cropClipInputs,
  cropLayers,
  cropOutcome,
  CUTOUT_NAME,
  cutLayer,
  deleteLayers,
  fitToBox,
  IDENTITY,
  layerBounds,
  localToDoc,
  mergeLayers,
  newDocument,
  placedBounds,
  planCrop,
  restyledTexts,
  scaleLongestSide,
  setTextStyle,
  setTextStyles,
  setTransform,
  textLayersOf,
  textStyleOf,
  type Doc,
  type TextRender,
  type TextStyle,
} from "../src/editor/model/document";
import { lassoRegion, rectRegion, regionBounds } from "../src/editor/model/region";
import { EditorSession } from "../src/editor/model/session";
import {
  defaultFontFamily,
  fontSizeProblem,
  isBlankText,
  isHexColor,
  nextStyleAfter,
  outlineWidthProblem,
  textLayerName,
} from "../src/editor/model/text";
import {
  cutBlocker,
  cropBlocker,
  cropTextNotice,
  editTextBlocker,
  escapeTarget,
  fontChoices,
  isCutShortcut,
  layerHint,
  matchFonts,
  mergeBlocker,
  textBlocker,
  textOverlayPlacement,
  cssFontFamily,
  overlayFontFamily,
} from "../src/editor/view/geometry";

function image(width: number, height: number, fill = 0): RgbaImage {
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4).fill(fill) };
}

function render(width: number, height: number): TextRender {
  return { image: image(width, height, 9), metrics: { originX: 2, originY: 0, ascent: 40, descent: 10, lineHeight: 60 } };
}

const HI: TextStyle = { text: "hi", fontFamily: "Arial", fontSize: 50, color: "#ff0000", outline: null };

/** A 512 canvas with a 100x100 image at (0, 0) and a 60x50 text layer at (`x`, `y`). */
function withText(x = 200, y = 200): Doc {
  const doc = newDocument(image(100, 100, 255), "base", { width: 512, height: 512 });
  return addTextLayer(setTransform(doc, "layer-1", IDENTITY), HI, render(60, 50), { ...IDENTITY, x, y });
}

// ---- Text layers ----

test("a text layer keeps its style and Rust rendering, and is named after its text", () => {
  const doc = withText();
  const text = doc.layers[1];
  expect(text.kind).toBe("text");
  if (text.kind !== "text") return;
  expect(textStyleOf(text)).toEqual(HI);
  expect(text.render.image.width).toBe(60);
  expect(text.name).toBe("hi");
  expect(layerBounds(text)).toEqual({ x: 200, y: 200, width: 60, height: 50 });
});

test("text layer names come from the first non-blank line, shortened", () => {
  expect(textLayerName("\n  Hello there \nsecond")).toBe("Hello there");
  expect(textLayerName("   ")).toBe("Text");
  const long = "x".repeat(60);
  expect(textLayerName(long)).toHaveLength(40);
  expect(textLayerName(long).endsWith("…")).toBe(true);
});

test("changing text or style is one step that keeps the layer's place; the same style is no step", () => {
  const session = new EditorSession(withText());
  const id = session.doc.layers[1].id;
  const before = session.doc;
  session.apply((d) => setTextStyle(d, id, { ...HI, text: "bye", fontSize: 80 }, render(120, 90)));
  const text = session.doc.layers[1];
  if (text.kind !== "text") throw new Error("not text");
  expect([text.id, text.name, text.fontSize, text.render.image.width]).toEqual([id, "bye", 80, 120]);
  expect(text.transform).toEqual(before.layers[1].transform);
  expect(session.canUndo).toBe(true);
  session.undo();
  expect(session.doc).toBe(before);
  // Re-applying the current style changes nothing (no undo step).
  expect(setTextStyle(before, id, HI, render(1, 1))).toBe(before);
  expect(() => setTextStyle(before, "layer-1", HI, render(1, 1))).toThrow("not a text layer");
});

test("an outline grows the layer's box around its text: the glyphs stay put (SPM-18)", () => {
  // The layer starts with the layout at (2, 0) in a 60x50 box at (200, 200);
  // the outline render grows the box to 64x54 with the layout at (4, 2) —
  // what a 2 px outline does — so the transform shifts by the growth and
  // the layout box (metrics origin through the transform) does not move.
  const session = new EditorSession(withText());
  const id = session.doc.layers[1].id;
  const before = session.doc;
  const beforeText = before.layers[1];
  if (beforeText.kind !== "text") throw new Error("not text");
  const grown: TextRender = { image: image(64, 54), metrics: { originX: 4, originY: 2, ascent: 40, descent: 10, lineHeight: 60 } };
  const style: TextStyle = { ...HI, outline: { color: "#ffffff", width: 2 } };
  session.apply((d) => setTextStyle(d, id, style, grown));
  const text = session.doc.layers[1];
  if (text.kind !== "text") throw new Error("not text");
  expect([text.render.image.width, text.render.image.height]).toEqual([64, 54]);
  expect(text.outline).toEqual({ color: "#ffffff", width: 2 });
  expect(text.transform).toEqual({ ...IDENTITY, x: 198, y: 198 });
  const at = localToDoc(text.transform, grown.metrics.originX, grown.metrics.originY);
  const was = localToDoc(beforeText.transform, beforeText.render.metrics.originX, beforeText.render.metrics.originY);
  expect(at).toEqual(was);
  session.undo();
  expect(session.doc).toBe(before);
});

test("anchoredTransform shifts through the layer's rotation and scale (SPM-18)", () => {
  // Rotated 90 at scale 2: a layout move of (3, 1) in box px (the origin
  // going from (5, 7) to (2, 6)) is the rotated, scaled shift of it.
  const t = anchoredTransform(
    { x: 10, y: 20, scaleX: 2, scaleY: 2, rotation: 90 },
    { originX: 5, originY: 7 },
    { originX: 2, originY: 6 },
  );
  expect(t.x).toBeCloseTo(8);
  expect(t.y).toBeCloseTo(26);
  expect([t.scaleX, t.scaleY, t.rotation]).toEqual([2, 2, 90]);
});

test("outline widths are whole px from 0 to the limit, 0 meaning no outline (SPM-18)", () => {
  expect(TEXT_OUTLINE_WIDTH).toEqual({ min: 0, max: limits.text.maxOutlineWidth });
  expect(outlineWidthProblem(0)).toBeNull();
  expect(outlineWidthProblem(TEXT_OUTLINE_WIDTH.max)).toBeNull();
  for (const bad of [-1, TEXT_OUTLINE_WIDTH.max + 1, 2.5, NaN]) {
    expect(outlineWidthProblem(bad)).toContain(`from 0 to ${TEXT_OUTLINE_WIDTH.max}`);
  }
});

test("restyledTexts carries an outline to every selected text layer; the same outline is no step (SPM-18)", () => {
  let doc = withText();
  doc = addTextLayer(doc, { ...HI, text: "yo" }, render(40, 30), { ...IDENTITY, x: 300, y: 300 });
  const ids = doc.layers.filter((l) => l.kind === "text").map((l) => l.id);
  const outlined = { color: "#ffffff", width: 8 };
  const changes = restyledTexts(doc, ids, { outline: outlined }).map((c) => ({ ...c, render: render(70, 55) }));
  expect(changes.map((c) => c.style.outline)).toEqual([outlined, outlined]);
  const session = new EditorSession(doc);
  session.apply((d) => setTextStyles(d, changes));
  expect(setTextStyles(session.doc, changes)).toBe(session.doc); // re-applying: no step
  session.undo();
  expect(session.doc).toBe(doc);
});

test("CMT-61: the sizing tools measure text by its rendered box, so Fit gives exactly 512", () => {
  // Text alone, scaled and rotated: its box under the transform is what Fit scales.
  let doc = newDocument(image(10, 10), "base", { width: 512, height: 512 });
  doc = addTextLayer(doc, HI, render(300, 80), { ...IDENTITY, x: 0, y: 0, rotation: 90, scaleX: 1.5, scaleY: 1.5 });
  doc = deleteLayers(doc, ["layer-1"]);
  const fitted = fitToBox(doc, contentBounds(doc), STICKER.side);
  expect(Math.max(contentBounds(fitted).width, contentBounds(fitted).height)).toBeCloseTo(512, 6);
  const scaled = scaleLongestSide(doc, contentBounds(doc), STICKER.side);
  expect(Math.max(scaled.width, scaled.height)).toBe(512);
  // Text stays text through the sizing tools: only its transform changes.
  const text = scaled.layers.find((l) => l.kind === "text");
  expect(text?.kind).toBe("text");
});

test("text layers merge: the merge blocker no longer refuses them", () => {
  const doc = withText();
  expect(mergeBlocker(doc.layers.map((l) => l.id))).toBeNull();
  const merged = mergeLayers(doc, doc.layers.map((l) => l.id), image(260, 250), IDENTITY);
  expect(merged.layers.map((l) => l.kind)).toEqual(["raster"]);
});

test("text and font rules come from limits.json", () => {
  expect(TEXT_FONT_SIZE).toEqual({ min: limits.text.minFontSize, max: limits.text.maxFontSize });
  expect(fontSizeProblem(TEXT_FONT_SIZE.min)).toBeNull();
  expect(fontSizeProblem(TEXT_FONT_SIZE.max)).toBeNull();
  for (const bad of [TEXT_FONT_SIZE.min - 1, TEXT_FONT_SIZE.max + 1, 12.5, NaN]) {
    expect(fontSizeProblem(bad)).toContain(`${TEXT_FONT_SIZE.max}`);
  }
  expect(isHexColor("#00ff7F")).toBe(true);
  expect(isHexColor("#fff")).toBe(false);
  expect(isHexColor("red")).toBe(false);
  expect(isBlankText(" \n\t")).toBe(true);
  expect(isBlankText(" a ")).toBe(false);
});

test("the first font is a common one when installed, else the first installed", () => {
  expect(defaultFontFamily(["Zapfino", "Arial", "Impact", "Segoe UI"])).toBe("Impact");
  expect(defaultFontFamily(["Zapfino", "Segoe UI", "Arial"])).toBe("Arial");
  expect(defaultFontFamily(["Zapfino", "DejaVu Sans"])).toBe("DejaVu Sans");
  expect(defaultFontFamily(["Zapfino", "Bodoni"])).toBe("Zapfino");
  expect(defaultFontFamily([])).toBeNull();
});

test("the text overlay lines up with the layer's layout, or centres on the canvas for new text", () => {
  const view = { scale: 2, x: 10, y: 20 };
  const fresh = textOverlayPlacement(view, null, { width: 512, height: 400 });
  expect(fresh).toEqual({ left: 10 + 256 * 2, top: 20 + 200 * 2, scale: 2, rotation: 0, centred: true });
  // Layout top-left (2, 0) moved up by half the line gap ((60 - 40 - 10) / 2 = 5).
  const layer = { transform: { ...IDENTITY, x: 100, y: 50, scaleX: 1.5, scaleY: 1.5 }, render: render(60, 50) };
  const placed = textOverlayPlacement(view, layer, { width: 512, height: 512 });
  expect(placed.left).toBeCloseTo(10 + (100 + 2 * 1.5) * 2);
  expect(placed.top).toBeCloseTo(20 + (50 - 5 * 1.5) * 2);
  expect([placed.scale, placed.rotation, placed.centred]).toEqual([3, 0, false]);
});

// ---- Crop and text (SPM-9 decision) ----

test("Crop keeps text inside the box as text, removes text outside it, and rasterises text across its edge", () => {
  // Make the canvas bigger than the box so text can be outside it.
  const big = (x: number, y: number): Doc => ({ ...withText(x, y), width: 800, height: 800 });
  const inside = big(400, 400);
  const boxed = cropBox(inside, STICKER.side);
  expect(planCrop(inside, boxed)[1]).toEqual({ kind: "keep", id: "layer-2" });
  const outside = big(0, 0); // box is (144, 144)-(656, 656); text 0..60
  expect(planCrop(outside, boxed)[1]).toEqual({ kind: "remove", id: "layer-2" });
  const across = big(120, 400);
  const plan = planCrop(across, boxed);
  expect(plan[1]).toEqual({ kind: "clip", id: "layer-2", rect: { x: 144, y: 400, width: 36, height: 50 } });
  const cropped = cropLayers(across, plan, new Map([["layer-2", image(36, 50, 7)]]));
  const clipped = cropped.layers.find((l) => l.id === "layer-2");
  expect(clipped).toMatchObject({ kind: "raster", name: "hi", transform: { ...IDENTITY, x: 144, y: 400 } });
  // Text alone outside the box still leaves a layer: the at-least-one rule holds.
  const onlyOutside = newDocument(image(10, 10), "b", { width: 800, height: 800 });
  const textOnly = addTextLayer(onlyOutside, HI, render(60, 50), { ...IDENTITY, x: 0, y: 0 });
  const both = planCrop({ ...textOnly, layers: [textOnly.layers[1]] }, boxed);
  expect(cropBlocker(both, boxed)).toContain("Nothing is inside the box");
});

test("text on Crop goes through the rotated-layer test, cropOutcome and cropClipInputs", () => {
  // A 20x2 text box turned 45 degrees from (6, -8): its bounding box overlaps
  // the 10x10 box at the origin, the turned box itself does not (SPM-6 quad test).
  const base = newDocument(image(4, 4, 255), "base", { width: 10, height: 10 });
  const box = { x: 0, y: 0, width: 10, height: 10 };
  const turned = addTextLayer(base, HI, render(20, 2), { ...IDENTITY, x: 6, y: -8, rotation: 45 });
  expect(planCrop(turned, box)[1]).toEqual({ kind: "remove", id: "layer-2" });
  expect(cropOutcome(planCrop(turned, box))).toBe("crop");
  // Alone, it blocks Crop with "Nothing is inside the box".
  const alone = { ...turned, layers: [turned.layers[1]] };
  expect(cropOutcome(planCrop(alone, box))).toBe("nothing-inside");
  // Moved 4 px left it truly crosses the box: Rust gets its text, not pixels.
  const crossing = addTextLayer(base, HI, render(20, 2), { ...IDENTITY, x: 2, y: -8, rotation: 45 });
  const plan = planCrop(crossing, box);
  expect(plan.map((a) => a.kind)).toEqual(["keep", "clip"]);
  const inputs = cropClipInputs(crossing, plan);
  expect(inputs).toHaveLength(1);
  const input = inputs[0];
  if (!("text" in input)) throw new Error("a crossing text layer must reach Rust as text");
  expect(input.text).toEqual(HI);
  expect(input.render).toBe((crossing.layers[1] as { render: TextRender }).render);
  expect(input.clip).toEqual((plan[1] as { rect: unknown }).rect);
  // Text inside the box is kept as text, and never sent to Rust.
  const inside = addTextLayer(base, HI, render(4, 4), { ...IDENTITY, x: 3, y: 3 });
  expect(cropOutcome(planCrop(inside, box))).toBe("nothing-outside");
  expect(cropClipInputs(inside, planCrop(inside, box))).toEqual([]);
});

// ---- Cut ----

test("localToDoc places a layer pixel through translate, rotate, scale", () => {
  expect(localToDoc({ ...IDENTITY, x: 10, y: 20 }, 3, 4)).toEqual({ x: 13, y: 24 });
  const p = localToDoc({ x: 10, y: 0, scaleX: 2, scaleY: 2, rotation: 90 }, 3, 1);
  expect(p.x).toBeCloseTo(10 - 2);
  expect(p.y).toBeCloseTo(6);
});

test("cut leaves a hole in the source and floats the cutout directly above it at the same spot, as one step", () => {
  let doc = newDocument(image(40, 30, 255), "base", { width: 512, height: 512 });
  doc = setTransform(doc, "layer-1", { x: 100, y: 50, scaleX: 2, scaleY: 2, rotation: 0 });
  doc = addRasterLayer(doc, image(5, 5), "top");
  const session = new EditorSession(doc);
  const hole = image(40, 30, 1);
  const cutout = image(10, 6, 2);
  session.apply((d) => cutLayer(d, "layer-1", { hole, cutout, x: 4, y: 3 }));
  const [source, floating, top] = session.doc.layers;
  expect(source).toMatchObject({ id: "layer-1", name: "base", image: hole });
  expect(source.transform).toEqual(doc.layers[0].transform);
  expect(floating).toMatchObject({ kind: "raster", id: "layer-3", name: CUTOUT_NAME, image: cutout });
  expect(floating.transform).toEqual({ x: 108, y: 56, scaleX: 2, scaleY: 2, rotation: 0 });
  expect(top.name).toBe("top");
  session.undo();
  expect(session.doc).toBe(doc);
  expect(() => cutLayer(doc, "layer-1", { hole: image(1, 1), cutout, x: 0, y: 0 })).toThrow("do not match");
});

test("cut needs one selected image layer and a selection that touches it", () => {
  const doc = withText();
  const region = rectRegion({ x: 10, y: 10 }, { x: 50, y: 40 });
  expect(cutBlocker(doc, [], region)).toBe("Select the one image layer to cut from.");
  expect(cutBlocker(doc, ["layer-1", "layer-2"], region)).toBe("Select the one image layer to cut from.");
  expect(cutBlocker(doc, ["layer-2"], region)).toContain("Text layers can't be cut");
  expect(cutBlocker(doc, ["layer-1"], null)).toContain("Draw a selection");
  const away = rectRegion({ x: 300, y: 300 }, { x: 320, y: 320 });
  expect(cutBlocker(doc, ["layer-1"], away)).toBe("The selection does not touch the selected layer.");
  expect(cutBlocker(doc, ["layer-1"], region)).toBeNull();
});

test("regions: rectangles normalise, empty ones and flat lassos are nothing", () => {
  const r = rectRegion({ x: 50, y: 40 }, { x: 10, y: 10 });
  expect(r?.points).toEqual([
    { x: 10, y: 10 },
    { x: 50, y: 10 },
    { x: 50, y: 40 },
    { x: 10, y: 40 },
  ]);
  expect(regionBounds(r!)).toEqual({ x: 10, y: 10, width: 40, height: 30 });
  expect(rectRegion({ x: 5, y: 5 }, { x: 5, y: 9 })).toBeNull();
  const lasso = lassoRegion([
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 10 },
  ]);
  expect(lasso?.points).toHaveLength(3);
  expect(lassoRegion([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }])).toBeNull();
  expect(lassoRegion([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBeNull();
});

test("the cut selection lives in the session and is not an undo step", () => {
  const session = new EditorSession(withText());
  let notified = 0;
  session.subscribe(() => notified++);
  const region = rectRegion({ x: 0, y: 0 }, { x: 5, y: 5 });
  session.commitRegion(region);
  expect(session.region).toBe(region);
  expect(notified).toBe(1);
  expect(session.canUndo).toBe(false);
  session.clearRegion();
  expect(session.region).toBeNull();
});

test("text renderings count toward the history's memory budget", () => {
  // A budget that holds one 100x100 rendering: older steps drop past it.
  const session = new EditorSession(withText(), 100 * 100 * 4);
  const id = "layer-2";
  session.apply((d) => setTextStyle(d, id, { ...HI, text: "a" }, render(100, 100)));
  session.apply((d) => setTextStyle(d, id, { ...HI, text: "b" }, render(100, 100)));
  session.apply((d) => setTextStyle(d, id, { ...HI, text: "c" }, render(100, 100)));
  session.undo();
  expect(session.canUndo).toBe(false);
});

// ---- Round-1 review fixes (SPM-9) ----

test("setTextStyles restyles several text layers as ONE undo step", () => {
  let doc = withText();
  doc = addTextLayer(doc, { ...HI, text: "yo" }, render(40, 30), { ...IDENTITY, x: 300, y: 300 });
  const ids = doc.layers.filter((l) => l.kind === "text").map((l) => l.id);
  const session = new EditorSession(doc);
  const before = session.doc;
  const changes = restyledTexts(before, [...ids, "layer-1"], { color: "#00ff00" }).map((c) => ({ ...c, render: render(70, 55) }));
  expect(changes.map((c) => c.id)).toEqual(ids); // the image layer is not a text layer
  session.apply((d) => setTextStyles(d, changes));
  expect(session.doc.layers.filter((l) => l.kind === "text").map((l) => (l.kind === "text" ? l.color : ""))).toEqual([
    "#00ff00",
    "#00ff00",
  ]);
  expect(session.doc.layers[0]).toBe(before.layers[0]); // untouched layers are reused
  session.undo();
  expect(session.doc).toBe(before);
  // A patch that changes nothing changes nothing.
  const same = restyledTexts(before, ids, {}).map((c) => ({ ...c, render: render(1, 1) }));
  expect(setTextStyles(before, same)).toBe(before);
});

test("the selected text layers come from the model, bottom to top, whatever the selection order", () => {
  let doc = withText();
  doc = addTextLayer(doc, { ...HI, text: "yo" }, render(40, 30));
  const [base, a, b] = doc.layers.map((l) => l.id);
  expect(textLayersOf(doc, [b, base, a]).map((l) => l.id)).toEqual([a, b]);
  const session = new EditorSession(doc);
  session.select(b);
  session.select(base, "toggle");
  expect(session.selectedTexts.map((l) => l.id)).toEqual([b]);
});

test("one textStyleOf serves layers and styles, keeping only the style fields", () => {
  const doc = withText();
  const layer = doc.layers[1];
  if (layer.kind !== "text") throw new Error("not text");
  expect(Object.keys(textStyleOf(layer)).sort()).toEqual(["color", "fontFamily", "fontSize", "outline", "text"]);
  expect(textStyleOf({ ...HI, extra: 1 } as TextStyle)).toEqual(HI);
});

test("localToDoc and placedBounds agree on where a rotated, scaled layer's corners go", () => {
  const t = { x: 10, y: 20, scaleX: 2, scaleY: 3, rotation: 90 };
  const corner = localToDoc(t, 4, 5);
  expect(corner.x).toBeCloseTo(10 - 15);
  expect(corner.y).toBeCloseTo(20 + 8);
  const b = placedBounds(4, 5, t);
  expect([b.x, b.y, b.width, b.height].map((v) => Math.round(v))).toEqual([-5, 20, 15, 8]);
});

test("the text blocker waits for fonts and shows why there are none", () => {
  expect(textBlocker(null, null)).toBe("Looking for the installed fonts…");
  expect(textBlocker(null, "No fonts were found on this computer.")).toBe("No fonts were found on this computer.");
  expect(textBlocker(["Arial"], null)).toBeNull();
});

test("Edit text needs exactly one selected text layer, or says why", () => {
  const doc = withText();
  const [base, text] = doc.layers.map((l) => l.id);
  expect(editTextBlocker(null, doc, [text])).toBeNull();
  expect(editTextBlocker(null, doc, [base])).toBe("Select one text layer to edit.");
  expect(editTextBlocker(null, doc, [base, text])).toBe("Select one text layer to edit.");
  expect(editTextBlocker(null, doc, [])).toBe("Select one text layer to edit.");
  expect(editTextBlocker("Looking for the installed fonts…", doc, [text])).toBe("Looking for the installed fonts…");
});

test("the font list adds an uninstalled family without changing the installed list", () => {
  const installed = ["Arial", "Segoe UI"];
  expect(fontChoices(installed, "Arial")).toBe(installed);
  expect(fontChoices(installed, "")).toBe(installed);
  expect(fontChoices(installed, "Gone Sans")).toEqual(["Arial", "Segoe UI", "Gone Sans"]);
  expect(installed).toEqual(["Arial", "Segoe UI"]);
});

test("Esc clears the cut selection first, then the layer selection", () => {
  expect(escapeTarget(rectRegion({ x: 0, y: 0 }, { x: 5, y: 5 }))).toBe("region");
  expect(escapeTarget(null)).toBe("selection");
});

test("Ctrl+X (or Cmd+X) is the Cut shortcut; Ctrl+C and modified variants are not", () => {
  const k = (key: string, o: object = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
  expect(isCutShortcut(k("x", { ctrlKey: true }))).toBe(true);
  expect(isCutShortcut(k("X", { metaKey: true }))).toBe(true);
  expect(isCutShortcut(k("x"))).toBe(false);
  expect(isCutShortcut(k("c", { ctrlKey: true }))).toBe(false);
  expect(isCutShortcut(k("x", { ctrlKey: true, shiftKey: true }))).toBe(false);
  expect(isCutShortcut(k("x", { ctrlKey: true, altKey: true }))).toBe(false);
});

test("the layer hint adds cut and text reasons only where they are relevant", () => {
  const doc = withText();
  const [base, text] = doc.layers.map((l) => l.id);
  const reasons = { merge: "M.", delete: null, cut: "C.", editText: "E." };
  const region = rectRegion({ x: 0, y: 0 }, { x: 5, y: 5 });
  expect(layerHint(doc, [], region, reasons)).toBe("");
  expect(layerHint(doc, [base], null, reasons)).toBe("M.");
  expect(layerHint(doc, [base], region, reasons)).toBe("M. C.");
  expect(layerHint(doc, [base, text], null, reasons)).toBe("M. E.");
});

test("every text-control change sticks for the next new text (owner re-test 2026-11-22)", () => {
  const next = { fontFamily: "Arial", fontSize: 64, color: "#000000", outline: null };
  expect(nextStyleAfter(next, { fontSize: 30 })).toEqual({ ...next, fontSize: 30 });
  expect(nextStyleAfter(next, { color: "#ffffff" })).toEqual({ ...next, color: "#ffffff" });
  // An outline change sticks the same way (SPM-18), 0-width never landing:
  // the control commits null for it, so the next new text starts clean.
  const outlined = { color: "#ffffff", width: 8 };
  expect(nextStyleAfter(next, { outline: outlined })).toEqual({ ...next, outline: outlined });
  expect(nextStyleAfter(next, { outline: null })).toEqual({ ...next, outline: null });
});

test("Crop notes how many crossing text layers became images (owner, 2026-11-22)", () => {
  const base = newDocument(image(4, 4, 255), "base", { width: 10, height: 10 });
  const box = { x: 0, y: 0, width: 10, height: 10 };
  const inside = addTextLayer(base, HI, render(4, 4), { ...IDENTITY, x: 2, y: 2 });
  expect(cropTextNotice(inside, planCrop(inside, box))).toBeNull(); // kept as text
  const one = addTextLayer(base, HI, render(20, 4), { ...IDENTITY, x: 5, y: 0 });
  expect(cropTextNotice(one, planCrop(one, box))).toBe(
    "1 text layer crossed the crop edge and was converted to an image.",
  );
  const two = addTextLayer(one, HI, render(20, 4), { ...IDENTITY, x: -5, y: 5 });
  expect(cropTextNotice(two, planCrop(two, box))).toBe(
    "2 text layers crossed the crop edge and were converted to images.",
  );
  // A crossing image layer is not text: no note.
  const img = newDocument(image(20, 4, 255), "wide", { width: 10, height: 10 });
  expect(cropTextNotice(img, planCrop(img, box))).toBeNull();
});

test("the font picker matches names starting with the query first, then containing it", () => {
  const fonts = ["Arial", "Comic Sans MS", "Impact", "Segoe UI", "Arial Black", "Calibri"];
  expect(matchFonts(fonts, "")).toBe(fonts);
  expect(matchFonts(fonts, "  ")).toBe(fonts);
  expect(matchFonts(fonts, "ari")).toEqual(["Arial", "Arial Black"]);
  expect(matchFonts(fonts, "I")).toEqual(["Impact", "Arial", "Comic Sans MS", "Segoe UI", "Arial Black", "Calibri"]);
  expect(matchFonts(fonts, "zz")).toEqual([]);
});

test("cssFontFamily quotes a family and escapes quotes and backslashes", () => {
  expect(cssFontFamily("Arial")).toBe('"Arial"');
  expect(cssFontFamily('Ab"c\\d')).toBe('"Ab\\"c\\\\d"');
});

test("overlayFontFamily puts the chosen font first, then the emoji style stack", () => {
  expect(overlayFontFamily("Impact")).toBe('"Impact", var(--font-emoji)');
  expect(overlayFontFamily('Ab"c\\d')).toBe('"Ab\\"c\\\\d", var(--font-emoji)');
});

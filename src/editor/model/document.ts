// The Editor document (ADR-0005): an immutable value. Every operation
// returns a new Doc and reuses every layer (and pixel buffer) it did not
// change, so history can keep whole states cheaply. No Konva, no DOM.
import { IMPORT_MAX_SIDE, type RgbaImage } from "./image";
import { textLayerName } from "./text";

/** Transform of a layer in document pixels; rotation in degrees (Konva's convention). */
export interface Transform {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number;
}

export const IDENTITY: Transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

/** Pixels: the base image, a pasted cutout, or a merge result. */
export interface RasterLayer {
  readonly kind: "raster";
  readonly id: string;
  readonly name: string;
  readonly transform: Transform;
  readonly image: RgbaImage;
}

/**
 * Where text sits in its box, in px at scale 1 (from the Rust layout): the
 * layout's top-left within the box and the font's line metrics. The view's
 * text-editing overlay lines itself up with these.
 */
export interface TextMetrics {
  readonly originX: number;
  readonly originY: number;
  readonly ascent: number;
  /** Below the baseline, positive. */
  readonly descent: number;
  readonly lineHeight: number;
}

/**
 * A text layer drawn at scale 1 by the Rust rasteriser (src-tauri/src/editor/text.rs):
 * the pixels the view shows, whose size is the layer's box. Derived from the
 * style, so it changes only together with it (ADR-0005; CMT-61: the view,
 * the sizing tools and Crop all measure text by this one box).
 */
export interface TextRender {
  readonly image: RgbaImage;
  readonly metrics: TextMetrics;
}

/** Text stays editable vector data until merged, cropped across or saved (SPEC §6). */
export interface TextLayer {
  readonly kind: "text";
  readonly id: string;
  readonly name: string;
  readonly transform: Transform;
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly color: string;
  readonly render: TextRender;
}

export type Layer = RasterLayer | TextLayer;

export interface TextStyle {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly color: string;
}

/** The canvas size plus layers, bottom to top. */
export interface Doc {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly Layer[];
  /** Next layer number: ids are never reused within a session. */
  readonly nextId: number;
}

/** A canvas size in document pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * A fresh document: the canvas starts at `canvas` (a session passes
 * `startCanvas` of its constraint set, SPEC §6), never sized to the image,
 * and the image sits on it at its native size, centred, free to overflow.
 */
export function newDocument(image: RgbaImage, name: string, canvas: Size): Doc {
  return {
    width: canvas.width,
    height: canvas.height,
    layers: [{ kind: "raster", id: "layer-1", name, transform: centeredPlacement(canvas, image), image }],
    nextId: 2,
  };
}

/** Where an opened or added image goes: native size, centred on the canvas, on whole pixels. */
export function centeredPlacement(canvas: Size, image: RgbaImage): Transform {
  return {
    ...IDENTITY,
    x: Math.round((canvas.width - image.width) / 2),
    y: Math.round((canvas.height - image.height) / 2),
  };
}

/** The id the next added or merged layer will get. */
export function nextLayerId(doc: Doc): string {
  return `layer-${doc.nextId}`;
}

/** Position of a layer in the stack (0 = bottom); throws when absent. */
export function layerIndex(doc: Doc, id: string): number {
  const index = doc.layers.findIndex((l) => l.id === id);
  if (index < 0) throw new Error(`layer ${id} does not exist`);
  return index;
}

function withLayers(doc: Doc, layers: readonly Layer[], nextId = doc.nextId): Doc {
  return { ...doc, layers, nextId };
}

function replaceAt(doc: Doc, id: string, update: (layer: Layer) => Layer): Doc {
  const index = layerIndex(doc, id);
  const layers = doc.layers.slice();
  layers[index] = update(layers[index]);
  return withLayers(doc, layers);
}

/** Add a raster layer on top. */
export function addRasterLayer(
  doc: Doc,
  image: RgbaImage,
  name: string,
  transform: Transform = IDENTITY,
): Doc {
  const layer: RasterLayer = { kind: "raster", id: nextLayerId(doc), name, transform, image };
  return withLayers(doc, [...doc.layers, layer], doc.nextId + 1);
}

/** The style fields of a text layer. */
export function textStyleOf(layer: TextLayer): TextStyle {
  const { text, fontFamily, fontSize, color } = layer;
  return { text, fontFamily, fontSize, color };
}

/** Add a text layer on top, named after its text; `render` is its Rust rendering. */
export function addTextLayer(
  doc: Doc,
  style: TextStyle,
  render: TextRender,
  transform: Transform = IDENTITY,
): Doc {
  const layer: TextLayer = {
    kind: "text",
    id: nextLayerId(doc),
    name: textLayerName(style.text),
    transform,
    ...textStyle(style),
    render,
  };
  return withLayers(doc, [...doc.layers, layer], doc.nextId + 1);
}

function textStyle(style: TextStyle): TextStyle {
  const { text, fontFamily, fontSize, color } = style;
  return { text, fontFamily, fontSize, color };
}

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return a.text === b.text && a.fontFamily === b.fontFamily && a.fontSize === b.fontSize && a.color === b.color;
}

/**
 * Change a text layer's text or style, with its new rendering. Its box's
 * top-left stays where it is; the layer is renamed after its text. The same
 * style returns the document as is (no undo step).
 */
export function setTextStyle(doc: Doc, id: string, style: TextStyle, render: TextRender): Doc {
  const layer = doc.layers[layerIndex(doc, id)];
  if (layer.kind !== "text") throw new Error(`layer ${id} is not a text layer`);
  if (sameStyle(layer, style)) return doc;
  return replaceAt(doc, id, () => ({ ...layer, ...textStyle(style), name: textLayerName(style.text), render }));
}

/** The pixels the view draws for a layer: a raster's image, or a text layer's rendering. */
export function layerImage(layer: Layer): RgbaImage {
  return layer.kind === "raster" ? layer.image : layer.render.image;
}

/** A layer's on-screen box in document pixels (text: its rendered box, CMT-61). */
export function layerBounds(layer: Layer): Rect {
  const image = layerImage(layer);
  return placedBounds(image.width, image.height, layer.transform);
}

export function setTransform(doc: Doc, id: string, transform: Transform): Doc {
  return replaceAt(doc, id, (layer) => ({ ...layer, transform }));
}

/** Replace a raster layer's pixels (pixel operations, brush strokes). */
export function setLayerImage(doc: Doc, id: string, image: RgbaImage): Doc {
  return replaceAt(doc, id, (layer) => {
    if (layer.kind !== "raster") throw new Error(`layer ${id} is not a raster layer`);
    return { ...layer, image };
  });
}

/** Move a layer to stack position `toIndex`, clamped to the stack. */
export function moveLayer(doc: Doc, id: string, toIndex: number): Doc {
  const from = layerIndex(doc, id);
  const layers = doc.layers.slice();
  const [layer] = layers.splice(from, 1);
  const to = Math.max(0, Math.min(layers.length, toIndex));
  layers.splice(to, 0, layer);
  return withLayers(doc, layers);
}

/** An axis-aligned rectangle in document pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * On-screen box of a `width` x `height` layer placed by `t` — translate,
 * then rotate (degrees, clockwise), then scale — exactly as the Konva view
 * and the Rust merge place it.
 */
export function placedBounds(width: number, height: number, t: Transform): Rect {
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([u, v]) => {
    const sx = u * t.scaleX;
    const sy = v * t.scaleY;
    return [t.x + sx * cos - sy * sin, t.y + sx * sin + sy * cos];
  });
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Union of rectangles; throws for none. */
export function unionRect(rects: readonly Rect[]): Rect {
  if (rects.length === 0) throw new Error("there is no content to measure");
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * The whole image's bounds: the union of every layer's on-screen box,
 * including parts beyond the canvas. A text layer's box is its Rust
 * rendering's, the same box merge, Crop and the save rasterise it into
 * (CMT-61), so "longest side exactly 512" holds for text too.
 */
export function contentBounds(doc: Doc): Rect {
  return unionRect(doc.layers.map(layerBounds));
}

/** Below this, two positions or sizes count as equal (float noise). */
const EPSILON = 1e-6;

/**
 * Whole-pixel snapping: a bound within this of a whole pixel counts as that
 * pixel. Matches `snap()` in src-tauri/src/editor/merge.rs, so a scaled side
 * like 342.0005 gives a 342 canvas exactly as the Rust merge does (no
 * spurious re-enabling of tools after a merge). It is deliberately coarser
 * than EPSILON, which only absorbs float noise when detecting a no-op.
 */
const PIXEL_SNAP = 1e-3;

/** Why `value` is not a valid free-resize longest side, or null when it is (SPEC §6). */
export function resizeSideProblem(value: number): string | null {
  return Number.isInteger(value) && value >= 1 && value <= IMPORT_MAX_SIDE
    ? null
    : `The longest side must be a whole number of pixels from 1 to ${IMPORT_MAX_SIDE}.`;
}

/**
 * Scale the whole image as ONE group — everything on the canvas, like
 * selecting every layer and resizing them together (owner, 2026-11-20) —
 * by `factor`, centred on a new `width` x `height` canvas. Only transforms
 * change: layers stay separate, text stays editable, pixels are resampled
 * when merged or saved. Already in place: the document is returned as is
 * (no undo step).
 */
function scaleGroup(doc: Doc, content: Rect, factor: number, width: number, height: number): Doc {
  // The content's top-left lands on whole pixels (PIXEL_SNAP keeps
  // noise like -1e-14 from flooring to -1, so re-applying is a no-op).
  const padX = Math.floor((width - content.width * factor) / 2 + PIXEL_SNAP);
  const padY = Math.floor((height - content.height * factor) / 2 + PIXEL_SNAP);
  const alreadyThere =
    doc.width === width &&
    doc.height === height &&
    Math.abs(factor - 1) < EPSILON &&
    Math.abs(content.x - padX) < EPSILON &&
    Math.abs(content.y - padY) < EPSILON;
  if (alreadyThere) return doc;
  return { ...scaleGroupTo(doc, content, factor, padX, padY), width, height };
}

/**
 * Scale every layer by `factor` about the group's top-left corner, then move
 * that corner to (`x`, `y`); the canvas is untouched. Uniform scaling
 * commutes with each layer's rotation.
 */
function scaleGroupTo(doc: Doc, content: Rect, factor: number, x: number, y: number): Doc {
  const layers = doc.layers.map((layer) => ({
    ...layer,
    transform: {
      ...layer.transform,
      x: (layer.transform.x - content.x) * factor + x,
      y: (layer.transform.y - content.y) * factor + y,
      scaleX: layer.transform.scaleX * factor,
      scaleY: layer.transform.scaleY * factor,
    },
  }));
  return withLayers(doc, layers);
}

function longestSideOf(content: Rect): number {
  const longest = Math.max(content.width, content.height);
  if (!(longest > 0)) throw new Error("there is no content to resize");
  return longest;
}

/**
 * Sizing tool 1 (SPEC §6): fit the whole image (`content`, the union of all
 * layers' on-screen boxes) into a `box` x `box` square (`box` is the
 * constraint set's side) and pad the rest with transparency: its longest
 * side becomes `box` (up or down), centred, and the canvas becomes the square.
 */
export function fitToBox(doc: Doc, content: Rect, box: number): Doc {
  return scaleGroup(doc, content, box / longestSideOf(content), box, box);
}

/**
 * Sizing tool 2 (SPEC §6): scale the whole image so its longest side is
 * `side` px (the constraint set's side). No padding: the canvas becomes the
 * scaled content, in whole pixels. The short side rounds UP (never above `side`),
 * so nothing is clipped; the longest side is exactly `side`.
 */
export function scaleLongestSide(doc: Doc, content: Rect, side: number): Doc {
  const problem = resizeSideProblem(side);
  if (problem) throw new Error(problem);
  const factor = side / longestSideOf(content);
  const fit = (size: number) => Math.max(1, Math.min(side, Math.ceil(size * factor - PIXEL_SNAP)));
  const width = fit(content.width);
  const height = fit(content.height);
  return scaleGroup(doc, content, factor, width, height);
}

/**
 * Sizing tool 3, free resize (SPEC §6): scale the whole image as one group
 * so its longest side is `side` px; the canvas size does not change. The
 * group keeps its centre, with its top-left rounded to whole pixels. Already
 * that size: the document is returned as is (no undo step).
 */
export function resizeLongestSide(doc: Doc, content: Rect, side: number): Doc {
  const problem = resizeSideProblem(side);
  if (problem) throw new Error(problem);
  const factor = side / longestSideOf(content);
  if (Math.abs(factor - 1) < EPSILON) return doc;
  const x = Math.round(content.x + (content.width - content.width * factor) / 2);
  const y = Math.round(content.y + (content.height - content.height * factor) / 2);
  return scaleGroupTo(doc, content, factor, x, y);
}

/** Why deleting would leave a session without layers (SPEC §6). */
export const KEEP_ONE_LAYER = "A session needs at least one layer; use Close to start over.";

/**
 * Delete layers as one operation (SPEC §6, owner decision 2026-11-20). A
 * session always keeps at least one layer; ids are never reused afterwards.
 */
export function deleteLayers(doc: Doc, ids: readonly string[]): Doc {
  const chosen = new Set(ids);
  if (chosen.size === 0) throw new Error("no layers chosen to delete");
  for (const id of chosen) layerIndex(doc, id); // throws for unknown layers
  if (chosen.size >= doc.layers.length) throw new Error(KEEP_ONE_LAYER);
  return withLayers(doc, doc.layers.filter((l) => !chosen.has(l.id)));
}

/**
 * Replace two or more layers with one merged raster layer (the composite
 * is produced in Rust, ADR-0005). The merged layer takes the slot of the
 * topmost chosen layer, so layers above the selection stay above it.
 */
export function mergeLayers(
  doc: Doc,
  ids: readonly string[],
  image: RgbaImage,
  transform: Transform,
): Doc {
  const chosen = new Set(ids);
  if (chosen.size < 2) throw new Error("merging needs at least two layers");
  const indices = [...chosen].map((id) => layerIndex(doc, id));
  const top = Math.max(...indices);
  const merged: RasterLayer = {
    kind: "raster",
    id: nextLayerId(doc),
    name: "Merged",
    transform,
    image,
  };
  const layers: Layer[] = [];
  doc.layers.forEach((layer, i) => {
    if (i === top) layers.push(merged);
    else if (!chosen.has(layer.id)) layers.push(layer);
  });
  return withLayers(doc, layers, doc.nextId + 1);
}

/**
 * The crop box (SPEC §6): the constraint set's `side`, capped at the canvas
 * size on each axis (owner, 2026-11-20), so it is never larger than the
 * canvas: a 512×439 canvas gets a 512×439 box. Centred on the canvas, with
 * its top-left rounded down to a whole pixel. The overlay draws exactly this
 * rectangle and Crop keeps exactly it.
 */
export function cropBox(canvas: Size, side: number): Rect {
  const width = Math.min(side, canvas.width);
  const height = Math.min(side, canvas.height);
  return {
    x: Math.floor((canvas.width - width) / 2),
    y: Math.floor((canvas.height - height) / 2),
    width,
    height,
  };
}

/** Snap to the nearest whole pixel when float noise is all that separates them (merge.rs `snap`). */
function snapPixel(v: number): number {
  return Math.abs(v - Math.round(v)) < PIXEL_SNAP ? Math.round(v) : v;
}

/** The whole pixels a rectangle touches: its bounds rounded outwards (after snapping). */
export function pixelBounds(r: Rect): Rect {
  const x = Math.floor(snapPixel(r.x));
  const y = Math.floor(snapPixel(r.y));
  return {
    x,
    y,
    width: Math.ceil(snapPixel(r.x + r.width)) - x,
    height: Math.ceil(snapPixel(r.y + r.height)) - y,
  };
}

/**
 * What Crop does to one layer:
 * - "keep": it lies inside the box, so it is left exactly as it is (text
 *   stays editable text);
 * - "remove": it lies entirely outside the box, so it is discarded;
 * - "clip": it crosses the box edge, so it is re-rendered (in Rust) into
 *   `rect`, the whole pixels it covers inside the box, and becomes an
 *   untransformed raster layer placed at `rect` (text is rasterised: it
 *   cannot stay editable and lose its outside part).
 * Text layers are measured by their rendered box, like images by theirs.
 */
export type CropAction =
  | { readonly kind: "keep"; readonly id: string }
  | { readonly kind: "remove"; readonly id: string }
  | { readonly kind: "clip"; readonly id: string; readonly rect: Rect };

/** Crop's plan for every layer, bottom to top (SPEC §6). */
export function planCrop(doc: Doc, box: Rect): CropAction[] {
  return doc.layers.map((layer): CropAction => {
    const b = pixelBounds(layerBounds(layer));
    const left = Math.max(b.x, box.x);
    const top = Math.max(b.y, box.y);
    const right = Math.min(b.x + b.width, box.x + box.width);
    const bottom = Math.min(b.y + b.height, box.y + box.height);
    if (right <= left || bottom <= top) return { kind: "remove", id: layer.id };
    const inside = left === b.x && top === b.y && right === b.x + b.width && bottom === b.y + b.height;
    if (inside) return { kind: "keep", id: layer.id };
    return { kind: "clip", id: layer.id, rect: { x: left, y: top, width: right - left, height: bottom - top } };
  });
}

/** Why Crop would leave a session without layers (SPEC §6). */
export const NOTHING_IN_BOX = "Nothing is inside the box: drag the image into it first.";

/**
 * Apply a crop plan as ONE operation (SPEC §6): clipped layers get their new
 * pixels (`images`, by layer id, each exactly its rect's size) at their rect,
 * untransformed, keeping their id, name and stack position; layers entirely
 * outside the box are removed. The canvas size never changes. A plan that
 * changes nothing returns the document as is (no undo step).
 */
export function cropLayers(
  doc: Doc,
  plan: readonly CropAction[],
  images: ReadonlyMap<string, RgbaImage>,
): Doc {
  if (plan.length !== doc.layers.length || plan.some((a, i) => a.id !== doc.layers[i].id)) {
    throw new Error("the crop plan does not match the document");
  }
  if (plan.every((a) => a.kind === "keep")) return doc;
  if (plan.every((a) => a.kind === "remove")) throw new Error(NOTHING_IN_BOX);
  const layers: Layer[] = [];
  plan.forEach((action, i) => {
    const layer = doc.layers[i];
    if (action.kind === "keep") layers.push(layer);
    if (action.kind !== "clip") return;
    const image = images.get(action.id);
    const { rect } = action;
    if (!image || image.width !== rect.width || image.height !== rect.height) {
      throw new Error(`the cropped pixels for layer ${action.id} do not match its box`);
    }
    // A clipped text layer becomes pixels: same id, name and stack position.
    const { id, name } = layer;
    layers.push({ kind: "raster", id, name, image, transform: { ...IDENTITY, x: rect.x, y: rect.y } });
  });
  return withLayers(doc, layers);
}

/** A point in document pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Where a layer's own pixel (`u`, `v`) is drawn in the document: its
 * transform applied (translate, rotate, scale; like placedBounds, the view
 * and Rust).
 */
export function localToDoc(t: Transform, u: number, v: number): Point {
  const rad = (t.rotation * Math.PI) / 180;
  const sx = u * t.scaleX;
  const sy = v * t.scaleY;
  return { x: t.x + sx * Math.cos(rad) - sy * Math.sin(rad), y: t.y + sx * Math.sin(rad) + sy * Math.cos(rad) };
}

/** What a cut produces (src-tauri/src/editor/cut.rs). */
export interface CutResult {
  /** The source's pixels with the selected ones cleared; the source's size. */
  readonly hole: RgbaImage;
  /** The selected pixels, trimmed to the visible ones. */
  readonly cutout: RgbaImage;
  /** The cutout's top-left in the source's own pixel grid. */
  readonly x: number;
  readonly y: number;
}

/** Name of the floating layer a cut creates. */
export const CUTOUT_NAME = "Cutout";

/**
 * Cut as ONE operation (SPEC §6, SPM-9): the source raster layer keeps a
 * transparent hole (same size and transform, so nothing moves), and the
 * selected pixels become a new floating layer directly above it, at the
 * same spot: it takes the source's rotation and scale, placed where the
 * cutout's top-left pixel was drawn.
 */
export function cutLayer(doc: Doc, sourceId: string, cut: CutResult): Doc {
  const index = layerIndex(doc, sourceId);
  const source = doc.layers[index];
  if (source.kind !== "raster") throw new Error(`layer ${sourceId} is not a raster layer`);
  if (cut.hole.width !== source.image.width || cut.hole.height !== source.image.height) {
    throw new Error(`the cut pixels for layer ${sourceId} do not match its size`);
  }
  const at = localToDoc(source.transform, cut.x, cut.y);
  const cutout: RasterLayer = {
    kind: "raster",
    id: nextLayerId(doc),
    name: CUTOUT_NAME,
    transform: { ...source.transform, x: at.x, y: at.y },
    image: cut.cutout,
  };
  const layers = doc.layers.slice();
  layers[index] = { ...source, image: cut.hole };
  layers.splice(index + 1, 0, cutout);
  return withLayers(doc, layers, doc.nextId + 1);
}

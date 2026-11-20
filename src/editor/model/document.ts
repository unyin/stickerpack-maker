// The Editor document (ADR-0005): an immutable value. Every operation
// returns a new Doc and reuses every layer (and pixel buffer) it did not
// change, so history can keep whole states cheaply. No Konva, no DOM.
import { MAX_SIDE, type RgbaImage } from "./image";

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

/** Text stays editable vector data until merged or saved (SPEC §6). */
export interface TextLayer {
  readonly kind: "text";
  readonly id: string;
  readonly name: string;
  readonly transform: Transform;
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly color: string;
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

/** A fresh document sized to the imported image (SPEC §6: canvas fits image). */
export function newDocument(image: RgbaImage, name: string): Doc {
  return {
    width: image.width,
    height: image.height,
    layers: [{ kind: "raster", id: "layer-1", name, transform: IDENTITY, image }],
    nextId: 2,
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

/** Add a text layer on top, named after its text. */
export function addTextLayer(doc: Doc, style: TextStyle, transform: Transform = IDENTITY): Doc {
  const layer: TextLayer = {
    kind: "text",
    id: nextLayerId(doc),
    name: style.text,
    transform,
    ...style,
  };
  return withLayers(doc, [...doc.layers, layer], doc.nextId + 1);
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

/** Telegram's sticker size: one side exactly 512 px (SPEC §7). */
export const STICKER_SIDE = 512;

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
 * including parts beyond the canvas. Raster layers are computed here; text
 * has no intrinsic size in the model, so `measureText` (the view's Konva
 * measurement) supplies each text layer's box — one measure for the view
 * and the tools.
 */
export function contentBounds(doc: Doc, measureText: (layer: TextLayer) => Rect): Rect {
  return unionRect(
    doc.layers.map((l) =>
      l.kind === "raster" ? placedBounds(l.image.width, l.image.height, l.transform) : measureText(l),
    ),
  );
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
  return Number.isInteger(value) && value >= 1 && value <= MAX_SIDE
    ? null
    : `The longest side must be a whole number of pixels from 1 to ${MAX_SIDE}.`;
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
  // Scale about the group's top-left corner, then move that corner to the
  // padding offset: uniform scaling commutes with each layer's rotation.
  const layers = doc.layers.map((layer) => ({
    ...layer,
    transform: {
      ...layer.transform,
      x: (layer.transform.x - content.x) * factor + padX,
      y: (layer.transform.y - content.y) * factor + padY,
      scaleX: layer.transform.scaleX * factor,
      scaleY: layer.transform.scaleY * factor,
    },
  }));
  return { ...doc, width, height, layers };
}

function longestSideOf(content: Rect): number {
  const longest = Math.max(content.width, content.height);
  if (!(longest > 0)) throw new Error("there is no content to resize");
  return longest;
}

/**
 * Sizing tool 1 (SPEC §6): fit the whole image (`content`, the union of all
 * layers' on-screen boxes) into a `box` x `box` square and pad the rest with
 * transparency: its longest side becomes `box` (up or down), centred, and
 * the canvas becomes the square.
 */
export function fitToBox(doc: Doc, content: Rect, box: number = STICKER_SIDE): Doc {
  return scaleGroup(doc, content, box / longestSideOf(content), box, box);
}

/**
 * Sizing tools 2 and 3 (SPEC §6): scale the whole image so its longest side
 * is `side` px — 512 for tool 2, the owner's entered value for tool 3 (free
 * resize). No padding: the canvas becomes the scaled content, in whole
 * pixels. The short side rounds UP (never above `side`), so nothing is
 * clipped; the longest side is exactly `side`.
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

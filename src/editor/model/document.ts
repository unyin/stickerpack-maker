// The Editor document (ADR-0005): an immutable value. Every operation
// returns a new Doc and reuses every layer (and pixel buffer) it did not
// change, so history can keep whole states cheaply. No Konva, no DOM.
import type { RgbaImage } from "./image";

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

/**
 * Sizing tool 1 (SPEC §6): fit the WHOLE image into a `box` x `box` square
 * and pad the rest with transparency. The canvas becomes the square; every
 * layer is scaled by one factor (so the longest canvas side fills the box,
 * up or down) and shifted so the image sits centred. Non-destructive: only
 * transforms change, so layers stay separate and text stays editable;
 * pixels are resampled when merged or saved. A canvas that already is the
 * box is returned unchanged (no undo step).
 */
export function fitToBox(doc: Doc, box: number = STICKER_SIDE): Doc {
  if (doc.width === box && doc.height === box) return doc;
  const factor = box / Math.max(doc.width, doc.height);
  const padX = (box - doc.width * factor) / 2;
  const padY = (box - doc.height * factor) / 2;
  // Scaling uniformly about the canvas origin commutes with each layer's
  // rotation, so position, size and rotation stay consistent.
  const layers = doc.layers.map((layer) => ({
    ...layer,
    transform: {
      ...layer.transform,
      x: layer.transform.x * factor + padX,
      y: layer.transform.y * factor + padY,
      scaleX: layer.transform.scaleX * factor,
      scaleY: layer.transform.scaleY * factor,
    },
  }));
  return { ...doc, width: box, height: box, layers };
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

// The Editor document (ADR-0005): an immutable value. Every operation
// returns a new Doc and reuses every layer (and pixel buffer) it did not
// change, so history can keep whole states cheaply. No Konva, no DOM.
import type { RgbaImage } from "../api";

/** Placement of a layer in document pixels; rotation in degrees (Konva's convention). */
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
  const layer: RasterLayer = { kind: "raster", id: `layer-${doc.nextId}`, name, transform, image };
  return withLayers(doc, [...doc.layers, layer], doc.nextId + 1);
}

/** Add a text layer on top, named after its text. */
export function addTextLayer(doc: Doc, style: TextStyle, transform: Transform = IDENTITY): Doc {
  const layer: TextLayer = {
    kind: "text",
    id: `layer-${doc.nextId}`,
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

/** Remove a layer; a document always keeps at least one. */
export function removeLayer(doc: Doc, id: string): Doc {
  const index = layerIndex(doc, id);
  if (doc.layers.length === 1) throw new Error("a document must keep at least one layer");
  return withLayers(doc, doc.layers.filter((_, i) => i !== index));
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
    id: `layer-${doc.nextId}`,
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

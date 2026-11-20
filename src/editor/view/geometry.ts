// Pure decisions behind the Editor view: no Konva, no DOM, unit-tested.
import {
  cropOutcome,
  fitToBox,
  KEEP_ONE_LAYER,
  layerBounds,
  localToDoc,
  NOTHING_IN_BOX,
  resizeLongestSide,
  resizeSideProblem,
  scaleLongestSide,
  type CropAction,
  type Doc,
  type Rect,
  type TextLayer,
} from "../model/document";
import { regionBounds, type Region } from "../model/region";
import type { ConstraintSet } from "../model/constraints";
import type { SelectMode } from "../model/session";

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 16;
/** Zoom factor per wheel notch. */
const ZOOM_STEP = 1.1;

/** How the stage shows the document: scale plus the document origin on screen. */
export interface ViewTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Fit the document into the view with a margin, centred. Never upscales
 * past 100%, so small stickers show their real pixels.
 */
export function fitView(view: Size, doc: Size, margin: number): ViewTransform {
  const fit = Math.min(
    (view.width - 2 * margin) / doc.width,
    (view.height - 2 * margin) / doc.height,
  );
  const scale = Math.max(MIN_ZOOM, Math.min(1, fit));
  return {
    scale,
    x: (view.width - doc.width * scale) / 2,
    y: (view.height - doc.height * scale) / 2,
  };
}

/**
 * Zoom one wheel notch around the pointer: negative `deltaY` zooms in. The
 * document point under the pointer stays under it. Clamped to MIN/MAX_ZOOM.
 */
export function zoomAround(view: ViewTransform, pointer: Point, deltaY: number): ViewTransform {
  const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.scale * factor));
  const docX = (pointer.x - view.x) / view.scale;
  const docY = (pointer.y - view.y) / view.scale;
  return { scale, x: pointer.x - docX * scale, y: pointer.y - docY * scale };
}

/**
 * Why the selection cannot be merged, or null when it can: merging needs
 * two or more layers. Text layers merge too: Rust rasterises them (SPM-9).
 */
export function mergeBlocker(_doc: Doc, selection: readonly string[]): string | null {
  if (selection.length < 2) return "Select two or more layers to merge.";
  return null;
}

/**
 * Why Cut is disabled, or null when it can run (SPM-9): it needs a
 * selection drawn on the canvas and exactly one selected image layer that
 * the selection touches. Text is cut only after merging it into an image.
 */
export function cutBlocker(doc: Doc, selection: readonly string[], region: Region | null): string | null {
  if (selection.length !== 1) return "Select the one image layer to cut from.";
  const layer = doc.layers.find((l) => l.id === selection[0]);
  if (!layer) return "Select the one image layer to cut from.";
  if (layer.kind === "text") return "Text layers can't be cut: merge the text into an image layer first.";
  if (!region) return "Draw a selection on the canvas with Rectangle or Lasso first.";
  const a = regionBounds(region);
  const b = layerBounds(layer);
  const apart = a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height;
  return apart ? "The selection does not touch the selected layer." : null;
}

/** Where the text-editing overlay goes on screen, in CSS px of the canvas host. */
export interface OverlayPlacement {
  /** Screen position of the anchor point. */
  readonly left: number;
  readonly top: number;
  /** CSS scale (view zoom times the layer's scale) and rotation in degrees. */
  readonly scale: number;
  readonly rotation: number;
  /** The anchor is the overlay's centre (new text) rather than its top-left. */
  readonly centred: boolean;
}

/**
 * Line the text-editing overlay up with a text layer, or centre it on the
 * canvas for new text. The overlay's top-left is the layout's top-left
 * moved up by half the line gap, because CSS centres each line's glyphs in
 * its line height (`line-height: normal` spacing, like the Rust layout).
 */
export function textOverlayPlacement(
  view: ViewTransform,
  layer: Pick<TextLayer, "transform" | "render"> | null,
  canvas: Size,
): OverlayPlacement {
  if (!layer) {
    return {
      left: view.x + (canvas.width / 2) * view.scale,
      top: view.y + (canvas.height / 2) * view.scale,
      scale: view.scale,
      rotation: 0,
      centred: true,
    };
  }
  const m = layer.render.metrics;
  const halfGap = (m.lineHeight - m.ascent - m.descent) / 2;
  const at = localToDoc(layer.transform, m.originX, m.originY - halfGap);
  return {
    left: view.x + at.x * view.scale,
    top: view.y + at.y * view.scale,
    scale: view.scale * layer.transform.scaleX,
    rotation: layer.transform.rotation,
    centred: false,
  };
}

/** Why the selection cannot be deleted, or null when it can (SPEC §6). */
export function deleteBlocker(doc: Doc, selection: readonly string[]): string | null {
  if (selection.length === 0) return "Select the layers to delete.";
  if (selection.length >= doc.layers.length) return KEEP_ONE_LAYER;
  return null;
}

export type SizeTool = "fit" | "longest" | "free";

/**
 * Why a sizing tool is disabled, or null when it can run: the entered value
 * is invalid (free resize only) or the tool would change nothing. `entered`
 * is the free-resize field as a number (NaN when empty); `content` is null
 * while nothing can be measured. Tools 1 and 2 target `constraints.side`;
 * tool 2 is greyed out when the set needs a square canvas (SPEC §6).
 */
export function sizeToolBlocker(
  tool: SizeTool,
  doc: Doc,
  content: Rect | null,
  entered: number,
  constraints: ConstraintSet,
): string | null {
  const target = constraints.side;
  if (tool === "longest" && constraints.square) {
    return `A ${constraints.mode} must be exactly ${target}×${target}, so use Fit to ${target}×${target}.`;
  }
  if (tool === "free") {
    const problem = resizeSideProblem(entered);
    if (problem) return problem;
  }
  if (!content) return "There is nothing to resize.";
  if (tool === "fit") {
    return fitToBox(doc, content, target) === doc ? `The image already fills ${target}×${target}.` : null;
  }
  const side = tool === "longest" ? target : entered;
  const next = tool === "longest" ? scaleLongestSide(doc, content, side) : resizeLongestSide(doc, content, side);
  return next === doc ? `The image's longest side is already ${side} px.` : null;
}

/** Ctrl (Cmd on macOS) or Shift + click toggles a layer in or out of the selection. */
export function selectModeFor(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): SelectMode {
  return event.ctrlKey || event.metaKey || event.shiftKey ? "toggle" : "replace";
}

/**
 * Why Crop is disabled, or null when it can run: it would change nothing
 * (every layer already inside the box), or it would discard every layer
 * (a session keeps at least one, SPEC §6).
 */
export function cropBlocker(plan: readonly CropAction[], box: Rect): string | null {
  switch (cropOutcome(plan)) {
    case "nothing-outside":
      return `Everything is already inside the ${box.width}×${box.height} box.`;
    case "nothing-inside":
      return NOTHING_IN_BOX;
    case "crop":
      return null;
  }
}

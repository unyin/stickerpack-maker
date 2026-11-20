// Pure decisions behind the Editor view: no Konva, no DOM, unit-tested.
import type { RgbaImage } from "../model/image";
import { IDENTITY, KEEP_ONE_LAYER, type Doc, type Transform } from "../model/document";
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

/** Where "Add image as layer" puts an image: centred, at its own size, on whole pixels. */
export function centeredPlacement(doc: Doc, image: RgbaImage): Transform {
  return {
    ...IDENTITY,
    x: Math.round((doc.width - image.width) / 2),
    y: Math.round((doc.height - image.height) / 2),
  };
}

/**
 * Why the selection cannot be merged, or null when it can: merging needs
 * two or more layers, all raster (text is rasterised by the text tool, SPM-9).
 */
export function mergeBlocker(doc: Doc, selection: readonly string[]): string | null {
  if (selection.length < 2) return "Select two or more layers to merge.";
  const chosen = doc.layers.filter((l) => selection.includes(l.id));
  if (chosen.some((l) => l.kind === "text")) {
    return "Text layers can't be merged yet: that arrives with the text tool.";
  }
  return null;
}

/** Why the selection cannot be deleted, or null when it can (SPEC §6). */
export function deleteBlocker(doc: Doc, selection: readonly string[]): string | null {
  if (selection.length === 0) return "Select the layers to delete.";
  if (selection.length >= doc.layers.length) return KEEP_ONE_LAYER;
  return null;
}

/** Ctrl (Cmd on macOS) or Shift + click toggles a layer in or out of the selection. */
export function selectModeFor(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): SelectMode {
  return event.ctrlKey || event.metaKey || event.shiftKey ? "toggle" : "replace";
}

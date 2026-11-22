// The refine brush (SPEC §6, SPM-7): Erase lowers a layer's alpha, Restore
// paints its restore source back, live in the webview while the stroke
// happens (ADR-0005); a finished stroke is ONE undo step. The brush is round
// with a one-pixel soft edge, sized in canvas pixels whatever the layer's
// scale or rotation. Pure TypeScript: the view only draws the dirty pixels.
import { refineLayerPixels } from "./background";
import { type Doc, type Point, type RasterLayer, type Rect, type Transform } from "./document";
import type { RgbaImage } from "./image";

export type BrushMode = "erase" | "restore";

/** Brush diameter in canvas px: its range and default (owner may retune). */
export const BRUSH_SIZE = { min: 1, max: 500, initial: 40 } as const;

/** Why `value` is not a valid brush size, or null when it is. */
export function brushSizeProblem(value: number): string | null {
  return Number.isInteger(value) && value >= BRUSH_SIZE.min && value <= BRUSH_SIZE.max
    ? null
    : `The brush size must be a whole number of pixels from ${BRUSH_SIZE.min} to ${BRUSH_SIZE.max}.`;
}

/** A stroke in progress on one raster layer. `working` is painted in place. */
export interface Stroke {
  readonly layerId: string;
  readonly mode: BrushMode;
  /** Radius in canvas (document) px. */
  readonly radius: number;
  readonly transform: Transform;
  /** The layer's pixels when the stroke began. */
  readonly start: RgbaImage;
  /** What Restore paints back (the layer's restore source); `start` for Erase. */
  readonly source: RgbaImage;
  /** A copy of `start` that the stroke paints: the layer's next pixels. */
  readonly working: RgbaImage;
  /** Per layer pixel, how strongly the stroke has covered it so far (0-255). */
  readonly coverage: Uint8Array;
  /** The last point painted, in document px. */
  last: Point | null;
  /** Whether any pixel of `working` differs from `start`. */
  changed: boolean;
}

/**
 * Start a stroke of `size` px (diameter) on a raster layer. Restore needs
 * the layer's restore source (check `restoreBlocker` first).
 */
export function beginStroke(layer: RasterLayer, mode: BrushMode, size: number): Stroke {
  const source = mode === "restore" ? layer.restoreSource : layer.image;
  if (!source) throw new Error(`layer ${layer.id} has nothing to restore`);
  const { width, height } = layer.image;
  return {
    layerId: layer.id,
    mode,
    radius: size / 2,
    transform: layer.transform,
    start: layer.image,
    source,
    working: { width, height, pixels: new Uint8ClampedArray(layer.image.pixels) },
    coverage: new Uint8Array(width * height),
    last: null,
    changed: false,
  };
}

/** Where a document point lies in a layer's own pixel grid (the inverse of `localToDoc`). */
export function docToLocal(t: Transform, x: number, y: number): Point {
  const rad = (t.rotation * Math.PI) / 180;
  const dx = x - t.x;
  const dy = y - t.y;
  return {
    x: (dx * Math.cos(rad) + dy * Math.sin(rad)) / t.scaleX,
    y: (-dx * Math.sin(rad) + dy * Math.cos(rad)) / t.scaleY,
  };
}

/** Distance from `p` to the segment `a`-`b`. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const length2 = vx * vx + vy * vy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / length2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/**
 * Paint from the stroke's last point to `at` (document px; the first call
 * paints a dot). Coverage only ever grows within a stroke, so going over
 * the same spot twice in one stroke does not erase it further. Returns the
 * layer pixels that changed (layer px), or null when none did.
 */
export function strokeTo(stroke: Stroke, at: Point): Rect | null {
  const a = stroke.last ?? at;
  stroke.last = at;
  const { width, height } = stroke.start;
  const t = stroke.transform;
  // The capsule's bounding box in document px, mapped into the layer's grid.
  const reach = stroke.radius + 1;
  const corners = [
    [Math.min(a.x, at.x) - reach, Math.min(a.y, at.y) - reach],
    [Math.max(a.x, at.x) + reach, Math.min(a.y, at.y) - reach],
    [Math.min(a.x, at.x) - reach, Math.max(a.y, at.y) + reach],
    [Math.max(a.x, at.x) + reach, Math.max(a.y, at.y) + reach],
  ].map(([x, y]) => docToLocal(t, x, y));
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y))));
  const x1 = Math.min(width, Math.ceil(Math.max(...corners.map((c) => c.x))));
  const y1 = Math.min(height, Math.ceil(Math.max(...corners.map((c) => c.y))));
  if (x1 <= x0 || y1 <= y0) return null;
  let dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  const { coverage } = stroke;
  const start = stroke.start.pixels;
  const source = stroke.source.pixels;
  const out = stroke.working.pixels;
  // localToDoc, unrolled: a pixel's centre on the canvas is origin + u*ex + v*ey.
  const rad = (t.rotation * Math.PI) / 180;
  const ex = { x: t.scaleX * Math.cos(rad), y: t.scaleX * Math.sin(rad) };
  const ey = { x: -t.scaleY * Math.sin(rad), y: t.scaleY * Math.cos(rad) };
  const centre = { x: 0, y: 0 };
  for (let v = y0; v < y1; v++) {
    for (let u = x0; u < x1; u++) {
      centre.x = t.x + (u + 0.5) * ex.x + (v + 0.5) * ey.x;
      centre.y = t.y + (u + 0.5) * ex.y + (v + 0.5) * ey.y;
      const d = segmentDistance(centre, a, at);
      const cover = Math.round(Math.max(0, Math.min(1, stroke.radius + 0.5 - d)) * 255);
      const i = v * width + u;
      if (cover <= coverage[i]) continue;
      coverage[i] = cover;
      const p = i * 4;
      let changed = false;
      if (stroke.mode === "erase") {
        const alpha = Math.round((start[p + 3] * (255 - cover)) / 255);
        changed = out[p + 3] !== alpha;
        out[p + 3] = alpha;
      } else {
        for (let c = 0; c < 4; c++) {
          const value = Math.round(start[p + c] + ((source[p + c] - start[p + c]) * cover) / 255);
          if (out[p + c] !== value) changed = true;
          out[p + c] = value;
        }
      }
      if (!changed) continue;
      stroke.changed ||= out[p] !== start[p] || out[p + 1] !== start[p + 1] || out[p + 2] !== start[p + 2] || out[p + 3] !== start[p + 3];
      dirty = dirty
        ? { x0: Math.min(dirty.x0, u), y0: Math.min(dirty.y0, v), x1: Math.max(dirty.x1, u + 1), y1: Math.max(dirty.y1, v + 1) }
        : { x0: u, y0: v, x1: u + 1, y1: v + 1 };
    }
  }
  return dirty && { x: dirty.x0, y: dirty.y0, width: dirty.x1 - dirty.x0, height: dirty.y1 - dirty.y0 };
}

/**
 * The finished stroke as ONE operation: the layer gets the painted pixels
 * and keeps (or starts) its restore source. A stroke that changed nothing,
 * or whose layer changed meanwhile (an undo mid-stroke), changes nothing.
 */
export function finishStroke(doc: Doc, stroke: Stroke): Doc {
  if (!stroke.changed) return doc;
  const layer = doc.layers.find((l) => l.id === stroke.layerId);
  if (!layer || layer.kind !== "raster" || layer.image !== stroke.start) return doc;
  return refineLayerPixels(doc, stroke.layerId, stroke.working);
}

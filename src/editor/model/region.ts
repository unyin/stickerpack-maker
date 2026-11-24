// The selection drawn on the canvas (SPM-9; the wand since SPM-22): what
// Cut lifts and Delete erases. Like the layer selection it lives in the
// session and is not an undo step (ADR-0005); a wand region is additionally
// bound to its target layer's pixels, so the session drops it on any
// document change. No Konva, no DOM.
import type { Point, Rect } from "./document";
import type { WandMask } from "./wand";

/** A rectangle or lasso selection: a closed polygon in document pixels (SPM-9). */
export interface PolygonRegion {
  readonly kind: "rect" | "lasso";
  /** The closed polygon's corners, in document pixels. */
  readonly points: readonly Point[];
}

/** A magic-wand selection (SPM-22): the coverage mask its clicks build. */
export interface WandRegion {
  readonly kind: "wand";
  /** The layer the mask belongs to, in its own pixel grid. */
  readonly targetId: string;
  readonly mask: WandMask;
  /** The mask's outlines in document pixels, for the dashed selection line. */
  readonly outlines: readonly (readonly Point[])[];
}

/** The selection drawn on the canvas, or none. */
export type Region = PolygonRegion | WandRegion;

/** Twice the polygon's signed area (shoelace). */
function doubleArea(points: readonly Point[]): number {
  let sum = 0;
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  });
  return sum;
}

/** The rectangle dragged from `a` to `b` (either direction); null when it has no area. */
export function rectRegion(a: Point, b: Point): Region | null {
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return {
    kind: "rect",
    points: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
  };
}

/**
 * The lasso through `points` (closed back to the first); repeated points
 * are dropped. Null when it encloses no area (fewer than three distinct
 * points, or all on a line).
 */
export function lassoRegion(points: readonly Point[]): Region | null {
  const kept = points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  if (kept.length < 3 || Math.abs(doubleArea(kept)) < 1e-9) return null;
  return { kind: "lasso", points: kept };
}

/** The region's bounding box in document pixels (a wand's: the box of its outlines). */
export function regionBounds(region: Region): Rect {
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of region.kind === "wand" ? region.outlines.flat() : region.points) {
    x = Math.min(x, p.x);
    y = Math.min(y, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x, y, width: right - x, height: bottom - y };
}

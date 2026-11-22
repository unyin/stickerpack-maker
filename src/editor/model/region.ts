// The cut selection (SPM-9): a rectangle or a lasso drawn on the canvas, a
// closed polygon in document pixels. Like the layer selection it lives in
// the session and is not an undo step (ADR-0005). No Konva, no DOM.
import type { Point, Rect } from "./document";

export type RegionKind = "rect" | "lasso";

export interface Region {
  readonly kind: RegionKind;
  /** The closed polygon's corners, in document pixels. */
  readonly points: readonly Point[];
}

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

/** The region's bounding box. */
export function regionBounds(region: Region): Rect {
  const xs = region.points.map((p) => p.x);
  const ys = region.points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

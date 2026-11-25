// The selection drawn on the canvas (SPM-9; the wand since SPM-22; composed
// across tools since SPM-23): what Cut lifts and Delete erases. Like the
// layer selection it lives in the session and is not a step of the
// document's history (ADR-0005); since SPM-23 it keeps its own step trail
// beside that history. A plain Rectangle/Lasso region is unanchored geometry
// in document pixels and survives document changes; a composed region is a
// floating stack of contributions — a wand fill in the grid it was filled
// in, or a polygon in document pixels — and dies with any change, like the
// wand's did. No Konva, no DOM.
import type { Point, Rect, Transform } from "./document";
import { wandModeFor, type WandMask, type WandMode } from "./wand";

/** A rectangle or lasso selection: a closed polygon in document pixels (SPM-9). */
export interface PolygonRegion {
  readonly kind: "rect" | "lasso";
  /** The closed polygon's corners, in document pixels. */
  readonly points: readonly Point[];
}

/** What a contribution does to the selection built before it (SPM-23). */
export type ContributionOp = "add" | "subtract";

/** A wand fill: the coverage mask a click built in its layer's own grid (SPM-22). */
export interface WandContribution {
  readonly kind: "wand";
  readonly op: ContributionOp;
  /** Where the fill's layer grid sits in the document. */
  readonly transform: Transform;
  readonly mask: WandMask;
}

/** A Rectangle/Lasso polygon, in document pixels, rasterised when the selection is resolved (SPM-23). */
export interface PolyContribution {
  readonly kind: "poly";
  readonly op: ContributionOp;
  /** Whether the boundary takes half coverage: the Feather checkbox's setting when it was drawn. */
  readonly feather: boolean;
  readonly points: readonly Point[];
  /** The tool that drew it, for the Actions list's name; absent falls back to the geometry (SPM-15). */
  readonly shape?: "rectangle" | "lasso";
}

/** One piece of a floating selection, tagged add or subtract. */
export type Contribution = WandContribution | PolyContribution;

/**
 * A floating selection (SPM-23, owner decision 2026-11-24): a stack of
 * contributions from any of the three tools, merged wherever it is resolved
 * — the target layer's own grid for Cut and Delete, the document's for the
 * dashed line.
 */
export interface ComposedRegion {
  readonly kind: "compose";
  /** In the order they were added; the first always adds. */
  readonly contributions: readonly Contribution[];
  /** The merged boundary in document pixels, for the dashed selection line. */
  readonly outlines: readonly (readonly Point[])[];
}

/** The selection drawn on the canvas, or none. */
export type Region = PolygonRegion | ComposedRegion;

/**
 * Why a composed selection cuts nothing: the webview's twin of Rust's
 * `NOTHING_TO_CUT`, for a merge that reaches no pixel of the layer.
 */
export const NOTHING_TO_CUT = "The selection holds no visible pixels of this layer; nothing was cut.";

/** The same, for Delete: the webview's twin of Rust's `NOTHING_TO_ERASE`. */
export const NOTHING_TO_ERASE = "The selection holds no visible pixels of this layer; nothing was erased.";

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
export function rectRegion(a: Point, b: Point): PolygonRegion | null {
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
export function lassoRegion(points: readonly Point[]): PolygonRegion | null {
  const kept = points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  if (kept.length < 3 || Math.abs(doubleArea(kept)) < 1e-9) return null;
  return { kind: "lasso", points: kept };
}

/** The region's bounding box in document pixels (a composed region's: the box of its outlines). */
export function regionBounds(region: Region): Rect {
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of region.kind === "compose" ? region.outlines.flat() : region.points) {
    x = Math.min(x, p.x);
    y = Math.min(y, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * The contribution stack a region stands for when another contribution
 * joins it: a composed region's own stack, or a plain Rectangle/Lasso as one
 * adding polygon (its boundary takes the current Feather setting, as a new
 * polygon's does).
 */
export function contributionsOf(region: Region, feather: boolean): readonly Contribution[] {
  return region.kind === "compose"
    ? [...region.contributions]
    : [{ kind: "poly", op: "add", feather, points: region.points }];
}

/** What a finished Rectangle/Lasso draw commits (SPM-23, owner decisions 2026-11-24). */
export type ShapeCommit =
  | { readonly kind: "plain"; readonly region: Region | null }
  | { readonly kind: "compose"; readonly op: ContributionOp; readonly points: readonly Point[] };

/**
 * What a released Rectangle (or closed Lasso) does, from the modifiers read
 * at that moment: with Shift or Alt over an existing selection it composes
 * the drawn polygon onto it (Shift wins when both are held; a modifier held
 * over a selection with nothing drawn leaves it as it is), and anything else
 * commits the draw as before — a plain region, or none for a click or a
 * lasso with no area.
 */
export function shapeCommit(
  drawn: PolygonRegion | null,
  current: Region | null,
  mods: { readonly shift: boolean; readonly alt: boolean },
): ShapeCommit {
  const mode = wandModeFor(mods.shift, mods.alt);
  if (mode === "replace" || !current) return { kind: "plain", region: drawn };
  return drawn ? { kind: "compose", op: mode, points: drawn.points } : { kind: "plain", region: current };
}

/**
 * How a wand click combines with the selection drawn (SPM-23: any region
 * composes, whichever tool or layer built it): a plain click replaces it,
 * Shift adds the clicked region and Alt subtracts it, and with no selection
 * every modifier acts as a plain click.
 */
export function wandCommitMode(
  region: Region | null,
  mods: { readonly shift: boolean; readonly alt: boolean },
): WandMode {
  return region ? wandModeFor(mods.shift, mods.alt) : "replace";
}

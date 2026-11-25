// The selection drawn on the canvas (SPM-9; the wand since SPM-22; composed
// across tools since SPM-23): what Cut lifts and Delete erases. Like the
// layer selection it lives in the session and is not a step of the
// document's history (ADR-0005); since SPM-23 it keeps its own step trail
// beside that history. A plain Rectangle/Lasso region is unanchored geometry
// in document pixels and survives document changes; a composed region is a
// floating stack of contributions — a wand fill in the grid it was filled
// in, or a polygon in document pixels — and dies with any change, like the
// wand's did. No Konva, no DOM.
import { localToDoc, pixelBounds, placedBounds, unionRect, type Point, type Rect, type Transform } from "./document";
import { traceOutlines, wandModeFor, type WandMask, type WandMode } from "./wand";

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
 * — the target layer's own grid for Cut and Delete, a grid covering its own
 * bounds for the dashed line (SPM-24).
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
 * The most grid pixels the dashed outline's merge may span (SPM-24). The
 * preview is display-only — Cut and Delete re-merge in the target layer's own
 * grid — so a selection reaching far past the canvas is coarsened rather than
 * allocated whole: 4096 x 4096, well under the compose command's own limit.
 * Accepted residual: on a coarsened grid an add thinner than the scale can miss
 * every sampled pixel centre, so the merge comes back empty and the selection
 * drops though Cut would act — reachable only by up-scaled layers.
 */
export const PREVIEW_GRID_PIXELS = 4096 * 4096;

/** The grid a floating selection is merged in for its dashed outline. */
export interface PreviewGrid {
  readonly width: number;
  readonly height: number;
  /** Grid to document: a translation to the box's corner, scaled when coarsened. */
  readonly transform: Transform;
}

/**
 * The grid that covers a stack's contributions wherever they sit (SPM-24,
 * owner report): the union of their document-space bounds — a wand mask's box
 * through its layer's transform, a polygon's points — whole pixels, so a
 * composed selection keeps the part past the canvas, as a plain one does. Over
 * `PREVIEW_GRID_PIXELS` it takes the smallest integer scale that fits (a grid
 * pixel then spans `scale` document pixels). Null when the stack covers no area.
 */
export function previewGrid(contributions: readonly Contribution[]): PreviewGrid | null {
  if (contributions.length === 0) return null;
  const box = pixelBounds(
    unionRect(
      contributions.map((contribution): Rect => {
        if (contribution.kind === "poly") return regionBounds({ kind: "lasso", points: contribution.points });
        // placedBounds boxes a layer from its local origin; a mask's box starts at (x, y),
        // so the transform moves its origin there first.
        const { x, y, width, height } = contribution.mask;
        const origin = localToDoc(contribution.transform, x, y);
        return placedBounds(width, height, { ...contribution.transform, x: origin.x, y: origin.y });
      }),
    ),
  );
  const { width, height } = box;
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return null;
  // The smallest integer scale whose grid fits, by binary search between a lower bound and
  // the 1x1 scale. Each term of the lower bound is valid (a fitting grid has area >=
  // w*h/s^2, and each side's cell count >= 1, so s >= w/P and s >= h/P). At the upper bound
  // the grid is 1x1, which fits; the cell count only shrinks as the scale grows, so the
  // search is valid and takes at most ~53 steps.
  const fits = (s: number): boolean => Math.ceil(width / s) * Math.ceil(height / s) <= PREVIEW_GRID_PIXELS;
  let lo = Math.max(
    1,
    Math.ceil(Math.sqrt((width * height) / PREVIEW_GRID_PIXELS)),
    Math.ceil(width / PREVIEW_GRID_PIXELS),
    Math.ceil(height / PREVIEW_GRID_PIXELS),
  );
  let hi = Math.max(lo, Math.ceil(Math.max(width, height)));
  // Past the safe-integer range the scale cannot be exact (also catches a non-finite bound
  // from width * height overflowing); no real selection reaches it.
  if (!Number.isSafeInteger(hi)) return null;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  const scale = lo;
  return {
    width: Math.ceil(width / scale),
    height: Math.ceil(height / scale),
    transform: { x: box.x, y: box.y, scaleX: scale, scaleY: scale, rotation: 0 },
  };
}

/**
 * Merge a floating selection for its dashed outline (SPM-23, SPM-24): the
 * stack composed over `previewGrid`, traced in document pixels; null when it
 * covers nothing (a subtract that emptied it). `compose` is the Rust merge.
 */
export async function mergeSelection(
  contributions: readonly Contribution[],
  compose: (width: number, height: number, transform: Transform, contributions: readonly Contribution[]) => Promise<WandMask>,
): Promise<ComposedRegion | null> {
  const grid = previewGrid(contributions);
  if (!grid) return null;
  const merged = await compose(grid.width, grid.height, grid.transform, contributions);
  return merged.width === 0 || merged.height === 0
    ? null
    : { kind: "compose", contributions, outlines: traceOutlines(merged, grid.transform) };
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

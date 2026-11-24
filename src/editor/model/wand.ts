// The magic-wand selection (SPEC §6, SPM-22): what a click builds — the
// coverage mask Rust's flood fill returns — and the pure decisions around
// it: the tolerance's range and the drag that sets it, how Shift and Alt
// combine masks on one layer, and the mask's outlines for the dashed
// selection line. No Konva, no DOM.
import { localToDoc, type Point, type Transform } from "./document";

/** Wand tolerance as a percent of full channel range: its range and default (owner decision 2026-11-24). */
export const TOLERANCE = { min: 0, max: 100, initial: 20 } as const;

/** The webview twin of Rust's `TRANSPARENT_SPOT`: why a fully transparent spot cannot be selected. */
export const NOTHING_TO_SELECT_TRANSPARENT = "Nothing to select there: that spot is fully transparent.";

/** The webview twin of Rust's `OUTSIDE_LAYER`: why a click outside the layer selects nothing. */
export const NOTHING_TO_SELECT_OUTSIDE = "Nothing to select there: that spot is outside the layer.";

/** Why `value` is not a valid tolerance, or null when it is. */
export function toleranceProblem(value: number): string | null {
  return Number.isInteger(value) && value >= TOLERANCE.min && value <= TOLERANCE.max
    ? null
    : `The tolerance must be a whole number from ${TOLERANCE.min} to ${TOLERANCE.max}.`;
}

/** A coverage mask in its target layer's own pixel grid, as Rust returns it. */
export interface WandMask {
  /** The mask's top-left in layer pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** `width * height` coverage bytes (0-255), row-major. */
  readonly coverage: Uint8Array;
}

/** How a click combines with the wand selection already on the canvas. */
export type WandMode = "replace" | "add" | "subtract";

/**
 * What the click's modifiers do (owner decision 2026-11-24): a plain click
 * replaces the selection, Shift adds the clicked region to it, Alt
 * subtracts it — the way back from an accidentally added region, since a
 * selection is session state and never an undo step (ADR-0005). Shift wins
 * when both are held. With no selection on the canvas every modifier acts
 * as a plain click; the caller also treats another layer's click as one.
 */
export function wandModeFor(shift: boolean, alt: boolean): WandMode {
  if (shift) return "add";
  return alt ? "subtract" : "replace";
}

/**
 * The mask a click leaves on the canvas: `fill` alone for a replacing
 * click, else its combination with the region's `base` over the two
 * masks' union. Adding takes the stronger coverage where regions overlap;
 * subtracting keeps the share of each pixel's coverage the fill does not
 * claim (the same share an erase keeps of a pixel's alpha).
 */
export function combineMasks(base: WandMask | null, fill: WandMask, mode: WandMode): WandMask {
  if (mode === "replace" || !base) return fill;
  const x = Math.min(base.x, fill.x);
  const y = Math.min(base.y, fill.y);
  const width = Math.max(base.x + base.width, fill.x + fill.width) - x;
  const height = Math.max(base.y + base.height, fill.y + fill.height) - y;
  const coverage = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const b = coverageAt(base, x + column, y + row);
      const f = coverageAt(fill, x + column, y + row);
      coverage[row * width + column] = mode === "add" ? Math.max(b, f) : Math.floor((b * (255 - f)) / 255);
    }
  }
  return { x, y, width, height, coverage };
}

/** A mask's coverage of a layer pixel (0 outside its bounds). */
function coverageAt(mask: WandMask, x: number, y: number): number {
  const column = x - mask.x;
  const row = y - mask.y;
  return column >= 0 && row >= 0 && column < mask.width && row < mask.height ? mask.coverage[row * mask.width + column] : 0;
}

/** Whether a mask covers any pixel at all (a subtract can empty it). */
export function anyCovered(mask: WandMask): boolean {
  return mask.coverage.some((c) => c > 0);
}

/** A wand press being dragged: where it began, and the tolerance it is setting. */
export interface WandGesture {
  /** Where the button went down, in document px. */
  readonly seed: Point;
  /** In percent, within TOLERANCE's range. */
  readonly tolerance: number;
  /** The press's document y, and the tolerance when the drag anchored. */
  readonly anchor: { readonly y: number; readonly value: number };
  /** Moved past the drag slop: no longer a click. */
  readonly dragged: boolean;
}

/** Screen px a press must travel before it counts as a drag (the lasso's and the warp's threshold). */
const WAND_DRAG_SLOP = 4;

/** Percent per screen px of vertical drag, the warp strength's own rate. */
const TOLERANCE_PER_PX = 0.5;

/** A press at `seed` with the bar's tolerance; a drag adjusts it from there. */
export function startWandGesture(seed: Point, tolerance: number): WandGesture {
  return { seed, tolerance, anchor: { y: seed.y, value: tolerance }, dragged: false };
}

/**
 * The pointer moved to `at` (document px) at view `zoom` (screen px per
 * document px). The tolerance follows the pointer's VERTICAL movement —
 * up increases, down decreases (the warp strength's convention, owner
 * decision 2026-11-23) — measured in screen px so it feels the same at
 * any zoom, and stays within its range.
 */
export function moveWandGesture(g: WandGesture, at: Point, zoom: number): WandGesture {
  const distance = Math.hypot(at.x - g.seed.x, at.y - g.seed.y);
  if (!g.dragged && distance * zoom <= WAND_DRAG_SLOP) return g;
  const tolerance = clampWhole(g.anchor.value - (at.y - g.anchor.y) * zoom * TOLERANCE_PER_PX);
  return { ...g, tolerance, dragged: true };
}

/** `value` rounded to a whole number within TOLERANCE's range. */
function clampWhole(value: number): number {
  return Math.max(TOLERANCE.min, Math.min(TOLERANCE.max, Math.round(value)));
}

/** The readout beside the pointer while a wand drag sets the tolerance. */
export function wandReadout(g: WandGesture): string {
  return `Tolerance ${g.tolerance}%`;
}

/**
 * While a press is dragged the layer re-fills only when the tolerance
 * crosses one of these percent steps: each re-fill round-trips the layer's
 * pixels (16 MB at 2000×2000), so a drag pays a handful of fills, not one
 * per integer.
 */
export const REFILL_STEP = 5;

/** The refill step a tolerance value falls in. */
export function refillStepOf(tolerance: number): number {
  return Math.floor(tolerance / REFILL_STEP);
}

/**
 * The mask's outlines in document pixels: the boundary between covered and
 * uncovered pixels traced into closed loops — a hole inside a region loops
 * too — each collapsed to the corners where it turns, to be drawn with the
 * region line's own dashed style. `transform` maps the mask's layer grid
 * into document pixels.
 */
export function traceOutlines(mask: WandMask, transform: Transform): readonly (readonly Point[])[] {
  const { width, height, coverage } = mask;
  const covered = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && coverage[y * width + x] > 0;

  // One directed edge per boundary step, clockwise around each covered
  // pixel, so every corner's incoming and outgoing edges balance and the
  // edges decompose into closed loops. A corner is `y * stride + x`.
  const stride = width + 1;
  const corner = (x: number, y: number): number => y * stride + x;
  const outgoing = new Map<number, number[]>();
  const edge = (from: number, to: number): void => {
    const list = outgoing.get(from);
    if (list) list.push(to);
    else outgoing.set(from, [to]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!covered(x, y)) continue;
      if (!covered(x, y - 1)) edge(corner(x, y), corner(x + 1, y));
      if (!covered(x + 1, y)) edge(corner(x + 1, y), corner(x + 1, y + 1));
      if (!covered(x, y + 1)) edge(corner(x + 1, y + 1), corner(x, y + 1));
      if (!covered(x - 1, y)) edge(corner(x, y + 1), corner(x, y));
    }
  }

  const loops: (readonly Point[])[] = [];
  for (const [start, targets] of outgoing) {
    while (targets.length > 0) {
      // Walk one loop from `start`, consuming its edges.
      const corners: [number, number][] = [];
      let at = start;
      for (;;) {
        const list = outgoing.get(at);
        const to = list?.pop();
        if (to === undefined) break; // balanced degrees make this unreachable
        corners.push([at % stride, Math.floor(at / stride)]);
        if (to === start) break;
        at = to;
      }
      if (corners.length < 4) continue;
      // Collapse the runs: only the corners where the walk turns survive.
      const points: Point[] = [];
      for (let i = 0; i < corners.length; i++) {
        const [pu, pv] = corners[(i + corners.length - 1) % corners.length];
        const [u, v] = corners[i];
        const [nu, nv] = corners[(i + 1) % corners.length];
        if (pu - u !== u - nu || pv - v !== v - nv) {
          points.push(localToDoc(transform, mask.x + u, mask.y + v));
        }
      }
      if (points.length >= 4) loops.push(points);
    }
  }
  return loops;
}

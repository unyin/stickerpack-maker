// The hybrid lasso being drawn (SPM-9, owner decision 2026-11-22, in the
// style of GIMP's Free Select): a click adds a waypoint (straight edge from
// the last point), a drag draws freehand, and the two mix in one lasso. It
// closes by pressing on its start point, by releasing a drag there, by a
// double-click on one spot, or by Enter; Esc cancels it and Backspace
// removes the last segment: the last waypoint, or the whole last freehand
// stroke (as GIMP's Backspace does). No button is held between points, so
// the view can be panned and zoomed mid-lasso. Pure: no Konva, no DOM.
// Points are document pixels; distances come in document pixels too (the
// caller divides screen px by the zoom).
import type { Point } from "../model/document";

/** One press of the left button on the lasso. */
export interface LassoPress {
  /** Where it went down. */
  readonly from: Point;
  /**
   * It travelled more than the drag slop from `from`: a freehand stroke,
   * not a click (a click's hand jitter stays a click).
   */
  readonly moved: boolean;
}

export interface LassoDraft {
  /** The points placed so far, the first being the start point. */
  readonly points: readonly Point[];
  /** The left button is down: moving draws freehand. */
  readonly pressed: boolean;
  /**
   * The current press, or once released the last one; null after
   * Backspace, so an undone click never pairs with the next one.
   */
  readonly press: LassoPress | null;
  /** The press before `press`, for the double-click test (null when there is none). */
  readonly previous: LassoPress | null;
  /**
   * Where each press's points begin in `points`, oldest first (the first is
   * 0): a press is one segment, a waypoint or a whole freehand stroke.
   */
  readonly starts: readonly number[];
}

/** What a press or release did: the draft after it, and whether the lasso closed. */
export interface LassoStep {
  readonly draft: LassoDraft | null;
  readonly close: boolean;
}

/** The distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** At least a triangle, and `at` is within `radius` of the start point. */
function closesAt(points: readonly Point[], at: Point, radius: number): boolean {
  return points.length >= 3 && distance(at, points[0]) <= radius;
}

/**
 * The left button goes down at `at`: start a lasso, close it on its start
 * point, or add a waypoint (which also starts a freehand stroke if the
 * pointer then moves). A new press becomes `press`, the one before it
 * `previous`, and its points start a new entry in `starts`.
 */
export function lassoPress(draft: LassoDraft | null, at: Point, closeRadius: number): LassoStep {
  const press = { from: at, moved: false };
  if (!draft) return { draft: { points: [at], pressed: true, press, previous: null, starts: [0] }, close: false };
  if (closesAt(draft.points, at, closeRadius)) return { draft, close: true };
  const points = [...draft.points, at];
  const starts = [...draft.starts, draft.points.length];
  return { draft: { points, pressed: true, press, previous: draft.press, starts }, close: false };
}

/**
 * The pointer moves to `at`: with the button down, freehand points every
 * `step` or more; the press becomes a stroke once it is more than `slop`
 * from where it went down.
 */
export function lassoDrag(draft: LassoDraft, at: Point, step: number, slop: number): LassoDraft {
  const { press } = draft;
  if (!draft.pressed || !press) return draft;
  const last = draft.points[draft.points.length - 1];
  if (distance(at, last) < step) return draft;
  const moved = press.moved || distance(at, press.from) > slop;
  return { ...draft, points: [...draft.points, at], press: { ...press, moved } };
}

/**
 * The left button goes up at `at`: a freehand stroke released on the start
 * point closes. The press is kept, so a following double-click knows
 * whether it was a stroke.
 */
export function lassoRelease(draft: LassoDraft, at: Point, closeRadius: number): LassoStep {
  const stroke = draft.press?.moved ?? false;
  return { draft: { ...draft, pressed: false }, close: stroke && closesAt(draft.points, at, closeRadius) };
}

/**
 * A double-click: it closes the lasso only when its two presses were both
 * clicks (not strokes) that went down on one spot (within `radius`), and
 * then drops every point the second press added. Konva reports any two
 * quick clicks as a double-click, even far apart or when one was a drag,
 * so quickly placed waypoints and quick strokes must not close the lasso.
 * The presses are compared, not the last points, so a click's jitter
 * points never pass for a double-click.
 */
export function lassoDoubleClick(draft: LassoDraft, radius: number): LassoStep {
  const { press, previous } = draft;
  if (!press || !previous || press.moved || previous.moved || distance(press.from, previous.from) > radius) {
    return { draft, close: false };
  }
  const points = draft.points.slice(0, draft.starts[draft.starts.length - 1]);
  return { draft: { ...draft, points, pressed: false, starts: draft.starts.slice(0, -1) }, close: true };
}

/**
 * Backspace: drop the last segment (the last press's waypoint, or its whole
 * freehand stroke); dropping the first one cancels the lasso (null).
 */
export function lassoUndo(draft: LassoDraft): LassoDraft | null {
  if (draft.starts.length <= 1) return null;
  const points = draft.points.slice(0, draft.starts[draft.starts.length - 1]);
  return { points, pressed: false, press: null, previous: null, starts: draft.starts.slice(0, -1) };
}

/**
 * What to draw: the points so far plus, between presses, a rubber band to
 * the pointer (where the next click would add a waypoint).
 */
export function lassoPreview(draft: LassoDraft, pointer: Point | null): readonly Point[] {
  return !draft.pressed && pointer ? [...draft.points, pointer] : draft.points;
}

// The hybrid lasso's drawing rules (SPM-9, owner decision 2026-11-22).
import { expect, test } from "bun:test";
import { lassoDoubleClick, lassoDrag, lassoPress, lassoPreview, lassoRelease, lassoUndo, type LassoDraft } from "../src/editor/view/lasso";

const R = 8; // close radius
const STEP = 2;
const SLOP = 4; // drag slop: a press moving further is a stroke

/** Click (press + release without moving) at each point in turn. */
function clicks(...points: [number, number][]): LassoDraft {
  let draft: LassoDraft | null = null;
  for (const [x, y] of points) {
    const pressed = lassoPress(draft, { x, y }, R);
    expect(pressed.close).toBe(false);
    draft = lassoRelease(pressed.draft!, { x, y }, R).draft!;
  }
  return draft!;
}

test("clicks add waypoints and the lasso stays open between them", () => {
  const draft = clicks([0, 0], [100, 0], [100, 100]);
  expect(draft.points).toEqual([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]);
  expect(draft.pressed).toBe(false);
});

test("pressing on the start point closes once there are three points", () => {
  const two = clicks([0, 0], [100, 0]);
  // With two points the start point is just another waypoint.
  expect(lassoPress(two, { x: 1, y: 1 }, R).close).toBe(false);
  const three = clicks([0, 0], [100, 0], [100, 100]);
  const near = lassoPress(three, { x: 5, y: 5 }, R);
  expect(near.close).toBe(true);
  expect(near.draft!.points).toHaveLength(3); // the closing press adds no point
  expect(lassoPress(three, { x: 9, y: 0 }, R).close).toBe(false);
});

test("a drag draws freehand points at least a step apart", () => {
  let draft = lassoPress(null, { x: 0, y: 0 }, R).draft!;
  draft = lassoDrag(draft, { x: 1, y: 0 }, STEP, SLOP); // too close: skipped
  expect(draft.points).toHaveLength(1);
  draft = lassoDrag(draft, { x: 3, y: 0 }, STEP, SLOP);
  draft = lassoDrag(draft, { x: 3, y: 5 }, STEP, SLOP);
  expect(draft.points).toEqual([
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 3, y: 5 },
  ]);
  expect(draft.press!.moved).toBe(true);
});

test("moving without the button only previews, it never adds points", () => {
  const draft = clicks([0, 0], [10, 0]);
  expect(lassoDrag(draft, { x: 50, y: 50 }, STEP, SLOP)).toBe(draft);
  expect(lassoPreview(draft, { x: 50, y: 50 })).toEqual([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 50, y: 50 },
  ]);
  expect(lassoPreview(draft, null)).toEqual(draft.points);
});

test("releasing a freehand stroke on the start point closes; elsewhere it stays open", () => {
  let draft = lassoPress(null, { x: 0, y: 0 }, R).draft!;
  for (const [x, y] of [
    [50, 0],
    [50, 50],
    [3, 4],
  ]) {
    draft = lassoDrag(draft, { x, y }, STEP, SLOP);
  }
  expect(lassoRelease(draft, { x: 3, y: 4 }, R).close).toBe(true);
  expect(lassoRelease(draft, { x: 30, y: 30 }, R).close).toBe(false);
});

test("clicks and drags mix in one lasso", () => {
  let draft = clicks([0, 0], [100, 0]);
  draft = lassoPress(draft, { x: 100, y: 50 }, R).draft!; // waypoint, then freehand from it
  draft = lassoDrag(draft, { x: 80, y: 80 }, STEP, SLOP);
  draft = lassoRelease(draft, { x: 80, y: 80 }, R).draft!;
  expect(draft.points).toHaveLength(4);
  expect(draft.pressed).toBe(false);
  expect(lassoPress(draft, { x: 2, y: 2 }, R).close).toBe(true);
});

test("a click on the start point right after starting does not close", () => {
  // The press and release of the very first click must not close a one-point lasso.
  const first = lassoPress(null, { x: 0, y: 0 }, R);
  expect(lassoRelease(first.draft!, { x: 0, y: 0 }, R).close).toBe(false);
});

test("Backspace drops the last waypoint, and dropping the only one cancels", () => {
  const draft = clicks([0, 0], [10, 0]);
  const one = lassoUndo(draft)!;
  expect(one.points).toEqual([{ x: 0, y: 0 }]);
  expect(lassoUndo(one)).toBeNull();
});

test("a double-click closes only when both presses land on one spot", () => {
  // Two quick waypoints far apart are not a double-click on the lasso.
  const apart = clicks([0, 0], [100, 0], [100, 100]);
  expect(lassoDoubleClick(apart, R)).toEqual({ draft: apart, close: false });
  // A real double-click: the second press repeats the point; it is dropped.
  const twice = clicks([0, 0], [100, 0], [100, 100], [101, 100]);
  const step = lassoDoubleClick(twice, R);
  expect(step.close).toBe(true);
  expect(step.draft!.points).toEqual(apart.points);
  expect(lassoDoubleClick(clicks([5, 5]), R).close).toBe(false);
});

test("a double-click does not close when the second press was a freehand stroke", () => {
  // Click at A, then press at B and drag: Konva still reports a double-click.
  let draft = clicks([0, 0], [100, 0], [100, 100]);
  draft = lassoPress(draft, { x: 100, y: 101 }, R).draft!;
  for (const [x, y] of [
    [104, 101],
    [108, 101],
    [112, 105],
    [116, 109],
  ]) {
    draft = lassoDrag(draft, { x, y }, STEP, SLOP);
  }
  draft = lassoRelease(draft, { x: 116, y: 109 }, R).draft!;
  expect(draft.press!.moved).toBe(true);
  expect(lassoDoubleClick(draft, R)).toEqual({ draft, close: false });
});

test("a double-click does not close after two freehand strokes in a row", () => {
  let draft = clicks([0, 0], [100, 0], [100, 100]);
  for (const y of [200, 300]) {
    draft = lassoPress(draft, { x: 100, y }, R).draft!;
    draft = lassoDrag(draft, { x: 103, y }, STEP, SLOP);
    draft = lassoDrag(draft, { x: 106, y }, STEP, SLOP);
    draft = lassoRelease(draft, { x: 106, y }, R).draft!;
  }
  expect(lassoDoubleClick(draft, R).close).toBe(false);
});

test("a click after a stroke resets moved, so a real double-click still closes", () => {
  let draft = lassoPress(null, { x: 0, y: 0 }, R).draft!;
  draft = lassoDrag(draft, { x: 100, y: 0 }, STEP, SLOP);
  draft = lassoRelease(draft, { x: 100, y: 0 }, R).draft!;
  expect(draft.press!.moved).toBe(true);
  for (const [x, y] of [
    [100, 100],
    [100, 100],
  ]) {
    draft = lassoRelease(lassoPress(draft, { x, y }, R).draft!, { x, y }, R).draft!;
  }
  expect(draft.press!.moved).toBe(false);
  expect(lassoDoubleClick(draft, R).close).toBe(true);
});

test("hand jitter within the drag slop keeps a press a click, so a double-click still closes", () => {
  let draft = clicks([0, 0], [100, 0], [100, 100]);
  // Second click of a double-click at (100, 100) that slips 3 px.
  draft = lassoPress(draft, { x: 100, y: 100 }, R).draft!;
  draft = lassoDrag(draft, { x: 103, y: 100 }, STEP, SLOP);
  expect(draft.points).toHaveLength(5); // the slip is drawn...
  expect(draft.press!.moved).toBe(false); // ...but it is still a click
  draft = lassoRelease(draft, { x: 103, y: 100 }, R).draft!;
  const closed = lassoDoubleClick(draft, R);
  expect(closed.close).toBe(true);
  expect(closed.draft!.points).toHaveLength(3); // the second press and its slip are dropped
  // Past the slop it is a stroke.
  const stroke = lassoDrag(lassoPress(draft, { x: 50, y: 50 }, R).draft!, { x: 55, y: 50 }, STEP, SLOP);
  expect(stroke.press!.moved).toBe(true);
});

test("two quick waypoints far apart never close, even when the second click slips", () => {
  // Round-3 review P5: the slip point sits next to the second click, but the presses are far apart.
  let draft = clicks([0, 0], [100, 0]);
  draft = lassoPress(draft, { x: 100, y: 100 }, R).draft!;
  draft = lassoDrag(draft, { x: 103, y: 100 }, STEP, SLOP);
  draft = lassoRelease(draft, { x: 103, y: 100 }, R).draft!;
  expect(draft.press!.moved).toBe(false);
  expect(lassoDoubleClick(draft, R).close).toBe(false);
});

test("a stroke then a quick click on its start spot is not a double-click", () => {
  let draft = clicks([0, 0], [100, 0], [100, 100]);
  draft = lassoPress(draft, { x: 50, y: 50 }, R).draft!;
  draft = lassoDrag(draft, { x: 60, y: 50 }, STEP, SLOP);
  draft = lassoRelease(draft, { x: 60, y: 50 }, R).draft!;
  draft = lassoRelease(lassoPress(draft, { x: 51, y: 50 }, R).draft!, { x: 51, y: 50 }, R).draft!;
  expect(lassoDoubleClick(draft, R).close).toBe(false);
});

test("after Backspace a double-click needs two new clicks", () => {
  const draft = lassoUndo(clicks([0, 0], [100, 0], [100, 100], [100, 100]))!;
  expect(lassoDoubleClick(draft, R).close).toBe(false);
});

test("a click undone with Backspace never pairs with the next click as a double-click", () => {
  // Round-4 review P6: click X, Backspace, click X again within Konva's double-click window.
  let draft = clicks([0, 0], [100, 0], [100, 100], [50, 50]);
  draft = lassoUndo(draft)!;
  draft = lassoRelease(lassoPress(draft, { x: 50, y: 50 }, R).draft!, { x: 50, y: 50 }, R).draft!;
  expect(lassoDoubleClick(draft, R).close).toBe(false);
});

test("Backspace drops a stroke's freehand points at once, keeping the waypoint it began at (owner re-test 2026-11-22)", () => {
  let draft = clicks([0, 0], [100, 0]);
  draft = lassoPress(draft, { x: 100, y: 100 }, R).draft!;
  for (let x = 96; x >= 20; x -= 4) draft = lassoDrag(draft, { x, y: 100 }, STEP, SLOP);
  draft = lassoRelease(draft, { x: 20, y: 100 }, R).draft!;
  expect(draft.points.length).toBeGreaterThan(20);
  const undone = lassoUndo(draft)!;
  expect(undone.points).toEqual([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]);
  // Then waypoint by waypoint, and the first one cancels.
  const twice = lassoUndo(undone)!;
  expect(twice.points).toEqual([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]);
  expect(lassoUndo(lassoUndo(twice)!)).toBeNull();
});

test("a click's jitter within the slop stays part of its waypoint for Backspace", () => {
  let draft = clicks([0, 0], [100, 0]);
  draft = lassoPress(draft, { x: 100, y: 100 }, R).draft!;
  draft = lassoDrag(draft, { x: 103, y: 100 }, STEP, SLOP); // a slip, still a click
  draft = lassoRelease(draft, { x: 103, y: 100 }, R).draft!;
  expect(lassoUndo(draft)!.points).toEqual([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]);
});

test("a lasso started with a freehand stroke: Backspace drops the stroke, then the start point cancels", () => {
  let draft = lassoPress(null, { x: 0, y: 0 }, R).draft!;
  draft = lassoDrag(draft, { x: 10, y: 0 }, STEP, SLOP);
  draft = lassoDrag(draft, { x: 10, y: 10 }, STEP, SLOP);
  draft = lassoRelease(draft, { x: 10, y: 10 }, R).draft!;
  const undone = lassoUndo(draft)!;
  expect(undone.points).toEqual([{ x: 0, y: 0 }]);
  expect(lassoUndo(undone)).toBeNull();
});

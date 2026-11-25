// Selection composition across tools (SPM-23, owner decisions 2026-11-24):
// the floating selection's model and bounds, how a released Rectangle/Lasso
// commits, the unified Cut/Delete blockers, and the session's drop rule.
import { expect, test } from "bun:test";
import type { RgbaImage } from "../src/editor/model/image";
import { startCanvas, STICKER } from "../src/editor/model/constraints";
import {
  addRasterLayer,
  addTextLayer,
  IDENTITY,
  newDocument,
  type Point,
  type TextRender,
  type TextStyle,
  type Transform,
} from "../src/editor/model/document";
import {
  contributionsOf,
  NOTHING_TO_CUT,
  NOTHING_TO_ERASE,
  mergeSelection,
  PREVIEW_GRID_PIXELS,
  previewGrid,
  rectRegion,
  shapeCommit,
  regionBounds,
  wandCommitMode,
  type ComposedRegion,
  type Contribution,
} from "../src/editor/model/region";
import type { WandMask } from "../src/editor/model/wand";
import { cutBlocker, eraseBlocker } from "../src/editor/view/geometry";

function image(width: number, height: number): RgbaImage {
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
}

const STICKER_CANVAS = startCanvas(STICKER);

function mask(x: number, y: number, width: number, height: number, coverage: number[]): WandMask {
  return { x, y, width, height, coverage: new Uint8Array(coverage) };
}

function wand(op: "add" | "subtract", transform: Transform, m: WandMask): Contribution {
  return { kind: "wand", op, transform, mask: m };
}

/** A composed region drawn from its contributions' outlines (the views' doc-grid preview). */
function composed(contributions: readonly Contribution[], outlines: readonly (readonly Point[])[]): ComposedRegion {
  return { kind: "compose", contributions, outlines };
}

const transform: Transform = { x: 200, y: 100, scaleX: 1, scaleY: 1, rotation: 0 };
const fill = wand("add", transform, mask(0, 0, 4, 4, new Array(16).fill(255)));
const square: Point[] = [
  { x: 10, y: 10 },
  { x: 20, y: 10 },
  { x: 20, y: 20 },
  { x: 10, y: 20 },
];

test("a composed selection is one area from any tool, bounded by its merged outlines", () => {
  const region = composed([fill, { kind: "poly", op: "subtract", feather: false, points: square }], [square]);
  expect(region.kind).toBe("compose");
  expect(region.contributions).toHaveLength(2);
  expect(regionBounds(region)).toEqual({ x: 10, y: 10, width: 10, height: 10 });
  // Every outline counts, holes included: the box never shrinks to one loop.
  const ring = composed([fill], [
    [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 8 },
      { x: 0, y: 8 },
    ],
    [
      { x: 3, y: 3 },
      { x: 5, y: 3 },
      { x: 5, y: 5 },
      { x: 3, y: 5 },
    ],
  ]);
  expect(regionBounds(ring)).toEqual({ x: 0, y: 0, width: 8, height: 8 });
});

test("a modifier read at release composes a Rectangle/Lasso onto the selection; anything else draws plainly", () => {
  const drawn = rectRegion({ x: 10, y: 10 }, { x: 20, y: 20 })!;
  const existing = composed([fill], [square]);
  // With no selection drawn, every modifier acts as a plain draw (the wand's own rule).
  expect(shapeCommit(drawn, null, { shift: true, alt: false })).toEqual({ kind: "plain", region: drawn });
  expect(shapeCommit(drawn, null, { shift: false, alt: true })).toEqual({ kind: "plain", region: drawn });
  // Without a modifier a draw replaces the selection, as before.
  expect(shapeCommit(drawn, existing, { shift: false, alt: false })).toEqual({ kind: "plain", region: drawn });
  // Shift adds the drawn polygon, Alt subtracts it, and Shift wins over Alt.
  expect(shapeCommit(drawn, existing, { shift: true, alt: false })).toEqual({ kind: "compose", op: "add", points: drawn.points });
  expect(shapeCommit(drawn, existing, { shift: false, alt: true })).toEqual({
    kind: "compose",
    op: "subtract",
    points: drawn.points,
  });
  expect(shapeCommit(drawn, existing, { shift: true, alt: true })).toEqual({ kind: "compose", op: "add", points: drawn.points });
  // A modifier over a selection with nothing drawn (a click or an empty lasso) keeps it.
  expect(shapeCommit(null, existing, { shift: true, alt: false })).toEqual({ kind: "plain", region: existing });
  // A plain click with nothing drawn clears, as before.
  expect(shapeCommit(null, existing, { shift: false, alt: false })).toEqual({ kind: "plain", region: null });
});

test("a plain Rectangle/Lasso joins a stack as one adding polygon, taking the Feather setting", () => {
  const plain = rectRegion({ x: 10, y: 10 }, { x: 20, y: 20 })!;
  expect(contributionsOf(plain, true)).toEqual([{ kind: "poly", op: "add", feather: true, points: plain.points }]);
  expect(contributionsOf(plain, false)).toEqual([{ kind: "poly", op: "add", feather: false, points: plain.points }]);
  // A composed region hands its own stack on, in order.
  const stack = composed([fill, { kind: "poly", op: "subtract", feather: true, points: square }], [square]);
  expect(contributionsOf(stack, false)).toEqual([fill, { kind: "poly", op: "subtract", feather: true, points: square }]);
  // A copy, so appending a contribution never mutates the region drawn.
  expect(contributionsOf(stack, false)).not.toBe(stack.contributions);
});

test("a wand click on another layer adds to the selection (corner change c)", () => {
  // The fill was drawn on a layer at (200, 100); the click may land on another
  // layer — any selection composes, whatever tool or layer built it.
  const otherLayerFill = wand("add", transform, mask(0, 0, 2, 2, [255, 255, 255, 255]));
  const region = composed([otherLayerFill], [square]);
  expect(wandCommitMode(region, { shift: true, alt: false })).toBe("add");
  expect(wandCommitMode(region, { shift: false, alt: true })).toBe("subtract");
  expect(wandCommitMode(region, { shift: false, alt: false })).toBe("replace");
  // With no selection on the canvas, modifiers act as a plain click.
  expect(wandCommitMode(null, { shift: true, alt: false })).toBe("replace");
  // The stack keeps the fill's own layer transform, so the apply can use it where it was drawn.
  const base = contributionsOf(region, true);
  expect(base).toHaveLength(1);
  expect(base[0]).toMatchObject({ kind: "wand", transform, mask: otherLayerFill.kind === "wand" ? otherLayerFill.mask : null });
});

test("Cut and Delete unify on the one selected image layer the selection touches", () => {
  const doc = newDocument(image(10, 10), "base", STICKER_CANVAS);
  const base = doc.layers[0].id;
  const at = doc.layers[0].transform;
  const onBase = composed(
    [wand("add", at, mask(0, 0, 4, 4, new Array(16).fill(255)))],
    [
      [
        { x: at.x, y: at.y },
        { x: at.x + 4, y: at.y },
        { x: at.x + 4, y: at.y + 4 },
        { x: at.x, y: at.y + 4 },
      ],
    ],
  );
  // The one selected image layer it touches: both actions run.
  expect(cutBlocker(doc, [base], onBase)).toBeNull();
  expect(eraseBlocker(doc, [base], onBase)).toBeNull();
  // No layer, or several: the reason names the one image layer needed.
  expect(cutBlocker(doc, [], onBase)).toBe("Select the one image layer to cut from.");
  expect(eraseBlocker(doc, [], onBase)).toBe("Select the one image layer to erase from.");
  // Another selected layer the selection does not touch is refused (corner change a).
  const aside = addRasterLayer(doc, image(10, 10), "pasted", { ...IDENTITY, x: 200, y: 200 });
  expect(cutBlocker(aside, [aside.layers[1].id], onBase)).toBe("The selection does not touch the selected layer.");
  expect(eraseBlocker(aside, [aside.layers[1].id], onBase)).toBe("The selection does not touch the selected layer.");
  // With no selection drawn, Cut still says to draw one.
  expect(cutBlocker(doc, [base], null)).toContain("Draw a selection");
  // Text has no pixels to cut or erase.
  const hi: TextStyle = { text: "hi", fontFamily: "Arial", fontSize: 50, color: "#ff0000", outline: null };
  const rendered: TextRender = {
    image: image(60, 50),
    metrics: { originX: 2, originY: 0, ascent: 40, descent: 10, lineHeight: 60 },
  };
  const withText = addTextLayer(doc, hi, rendered, { ...IDENTITY, x: at.x, y: at.y });
  expect(cutBlocker(withText, [withText.layers[1].id], onBase)).toContain("Text layers can't be cut");
  expect(eraseBlocker(withText, [withText.layers[1].id], onBase)).toContain("Text layers have no pixels to erase");
});

test("a composed selection with no pixels in the layer says so in the apply's own words", () => {
  // The webview twins of Rust's refusals for a merge that reaches no visible pixel.
  expect(NOTHING_TO_CUT).toBe("The selection holds no visible pixels of this layer; nothing was cut.");
  expect(NOTHING_TO_ERASE).toBe("The selection holds no visible pixels of this layer; nothing was erased.");
});

// ---- The preview grid covers what the stack covers, not the canvas (SPM-24) ----

function rectPoly(left: number, top: number, right: number, bottom: number): Contribution {
  const points = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  return { kind: "poly", op: "add", feather: false, points };
}

test("a polygon past the canvas's right and bottom edge is covered by the preview grid", () => {
  const grid = previewGrid([rectPoly(90.5, 40, 130.2, 75.1)]);
  expect(grid).toEqual({ width: 41, height: 36, transform: { x: 90, y: 40, scaleX: 1, scaleY: 1, rotation: 0 } });
});

test("a polygon at negative coordinates is covered by the preview grid", () => {
  const grid = previewGrid([rectPoly(-30.5, -10, 5, 8)]);
  expect(grid).toEqual({ width: 36, height: 18, transform: { x: -31, y: -10, scaleX: 1, scaleY: 1, rotation: 0 } });
});

test("a wand contribution is covered by its mask box's transformed corners", () => {
  const wand = (transform: Transform): Contribution => ({
    kind: "wand",
    op: "add",
    transform,
    mask: mask(2, 1, 4, 3, new Array(12).fill(255)),
  });
  // Translated and scaled: local x 2..6, y 1..4 -> document 10+4..10+12, 20+3..20+12.
  const placed = previewGrid([wand({ x: 10, y: 20, scaleX: 2, scaleY: 3, rotation: 0 })]);
  expect(placed).toEqual({ width: 8, height: 9, transform: { x: 14, y: 23, scaleX: 1, scaleY: 1, rotation: 0 } });
  // Rotated 90 degrees: (u, v) -> (-v, u), so x -4..-1 and y 2..6 from the origin.
  const turned = previewGrid([wand({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 90 })]);
  expect(turned?.transform.x).toBe(-4);
  expect(turned?.transform.y).toBe(2);
  expect(turned?.width).toBe(3);
  expect(turned?.height).toBe(4);
});

test("the preview grid is the union of every contribution, subtracts included", () => {
  const grid = previewGrid([rectPoly(-5, 0, 10, 10), { ...rectPoly(8, 8, 40, 12), op: "subtract" }, rectPoly(0, -3, 6, 4)]);
  expect(grid).toEqual({ width: 45, height: 15, transform: { x: -5, y: -3, scaleX: 1, scaleY: 1, rotation: 0 } });
});

test("an empty stack or a zero-area box has no preview grid", () => {
  expect(previewGrid([])).toBeNull();
  expect(previewGrid([rectPoly(5, 5, 5, 20)])).toBeNull();
});

test("a box over the cap coarsens by the smallest integer scale that fits", () => {
  const side = Math.sqrt(PREVIEW_GRID_PIXELS);
  // Exactly at the cap: no coarsening.
  expect(previewGrid([rectPoly(0, 0, side, side)])?.transform.scaleX).toBe(1);
  // One pixel wider: scale 2 is the smallest that fits.
  const over = previewGrid([rectPoly(-10, 0, side - 9, side)]);
  expect(over?.transform).toEqual({ x: -10, y: 0, scaleX: 2, scaleY: 2, rotation: 0 });
  expect(over?.width).toBe(Math.ceil((side + 1) / 2));
  expect(over?.height).toBe(side / 2);
  // A huge box still ends under the cap.
  const huge = previewGrid([rectPoly(0, 0, 40000, 30000)]);
  expect(huge).not.toBeNull();
  expect(huge!.width * huge!.height).toBeLessThanOrEqual(PREVIEW_GRID_PIXELS);
  expect(huge!.transform.scaleX).toBe(huge!.transform.scaleY);
  const smaller = Math.ceil(40000 / (huge!.transform.scaleX - 1)) * Math.ceil(30000 / (huge!.transform.scaleX - 1));
  expect(smaller).toBeGreaterThan(PREVIEW_GRID_PIXELS);
});

/** A compose stand-in that records the grid it is asked for and returns a solid mask over all of it. */
function recordingCompose(): { asked: { width: number; height: number; transform: Transform }[]; compose: Parameters<typeof mergeSelection>[1] } {
  const asked: { width: number; height: number; transform: Transform }[] = [];
  return {
    asked,
    compose: async (width, height, grid) => {
      asked.push({ width, height, transform: grid });
      return mask(0, 0, width, height, new Array(width * height).fill(255));
    },
  };
}

test("the outline merge is asked for a grid over the off-canvas box, not the canvas", async () => {
  const { asked, compose } = recordingCompose();
  await mergeSelection([rectPoly(-30, -20, -10, -5), rectPoly(500, 400, 520, 430)], compose);
  expect(asked).toEqual([{ width: 550, height: 450, transform: { x: -30, y: -20, scaleX: 1, scaleY: 1, rotation: 0 } }]);
});

test("a composed selection wholly at negative coordinates keeps its outlines there", async () => {
  const { compose } = recordingCompose();
  const region = await mergeSelection([rectPoly(-30, -20, -10, -5)], compose);
  const xs = region!.outlines.flat().map((p) => p.x);
  const ys = region!.outlines.flat().map((p) => p.y);
  expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([-30, -10, -20, -5]);
});

test("a composed selection reaching past the canvas keeps its outline there", async () => {
  const { compose } = recordingCompose();
  const region = await mergeSelection([rectPoly(90, 90, 140, 130)], compose);
  const xs = region!.outlines.flat().map((p) => p.x);
  expect(Math.max(...xs)).toBe(140);
  expect(region!.contributions).toHaveLength(1);
});

test("a merge that covers nothing, or a stack with no area, is no region", async () => {
  expect(await mergeSelection([rectPoly(0, 0, 10, 10)], async () => mask(0, 0, 0, 0, []))).toBeNull();
  let called = false;
  expect(await mergeSelection([], async () => ((called = true), mask(0, 0, 0, 0, [])))).toBeNull();
  expect(called).toBe(false);
});

test("an infinite coordinate gives no preview grid rather than hanging", () => {
  expect(previewGrid([rectPoly(0, 0, Infinity, 10)])).toBeNull();
});

test("a skinny box gets the smallest fitting scale", () => {
  const grid = previewGrid([rectPoly(0, 0, 1e9, 1)]);
  expect(grid).not.toBeNull();
  const scale = grid!.transform.scaleX;
  expect(grid!.width * grid!.height).toBeLessThanOrEqual(PREVIEW_GRID_PIXELS);
  expect(Math.ceil(1e9 / (scale - 1)) * Math.ceil(1 / (scale - 1))).toBeGreaterThan(PREVIEW_GRID_PIXELS);
});

test("a box whose area overflows has no preview grid", () => {
  expect(previewGrid([rectPoly(0, 0, 1e200, 1e200)])).toBeNull();
});

test("a box spanning one or two grid cells on a side gets the smallest fitting scale", () => {
  const w = 1.66e13;
  const h = 1.01e6;
  const grid = previewGrid([rectPoly(0, 0, w, h)]);
  expect(grid).not.toBeNull();
  const scale = grid!.transform.scaleX;
  expect(Math.ceil(w / scale) * Math.ceil(h / scale)).toBeLessThanOrEqual(PREVIEW_GRID_PIXELS);
  expect(Math.ceil(w / (scale - 1)) * Math.ceil(h / (scale - 1))).toBeGreaterThan(PREVIEW_GRID_PIXELS);
});

test("a huge finite box returns promptly, with no grid past the safe-integer range", () => {
  expect(previewGrid([rectPoly(0, 0, 1.55e61, 6.06e54)])).toBeNull();
});

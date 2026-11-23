// The warp/bulge brush (SPEC §6 "Enlarge selected parts", SPM-8): its
// pixel maths and its gesture. A bulge magnifies the pixels around its
// centre in place, meme style, within its radius; pixels outside it are
// untouched and the image keeps its size, so it stays one piece. A
// destructive brush (owner decision 2026-11-21): each press places ONE
// bulge, painted live in the webview (ADR-0005), and its release is ONE
// undo step. A click uses the slider values; a press-drag sets the radius
// from the pointer's distance to the press point, or (holding Shift) the
// strength from the pointer's vertical movement — up increases, down
// decreases (owner decisions 2026-11-22 and 2026-11-23). No Konva, no DOM.
import type { Point, Rect } from "./document";
import type { RgbaImage } from "./image";
import type { Range } from "./effects";

/** Warp settings as the controls hold them: strength in percent, radius in document px. */
export interface WarpSettings {
  readonly strength: number;
  readonly radius: number;
}

// Ranges, defaults and the brush feel below are a parked owner decision
// (SPM-8 tracker): tune them here.
export const WARP_STRENGTH: Range = { min: 1, max: 100, initial: 30 };
export const WARP_RADIUS: Range = { min: 5, max: 300, initial: 60 };
export const WARP_DEFAULTS: WarpSettings = { strength: WARP_STRENGTH.initial, radius: WARP_RADIUS.initial };

/** Strongest per-dab amount (at 100%): the centre is magnified 1 / (1 - this) = 10 times. Below 1, so it never folds. */
const MAX_AMOUNT = 0.9;

/** A press that travels more than this many screen px is a drag, not a click (as the lasso's). */
export const WARP_DRAG_SLOP = 4;

/** Strength percent per screen px of vertical pointer travel while Shift is held ("about 1% per 2 px"). */
const STRENGTH_PER_PX = 0.5;

/** A strength percentage as a dab's amount, from 0 (nothing) to MAX_AMOUNT. */
export function warpAmount(strength: number): number {
  return (Math.max(0, Math.min(100, strength)) / 100) * MAX_AMOUNT;
}

/**
 * One bulge dab, in place: each pixel within `radius` of (`cx`, `cy`) (in
 * the image's own pixels) shows what lay closer to the centre, by the
 * factor m(d) = 1 - amount * (1 - d)^2 at distance fraction d. m(1) = 1 and
 * m'(1) = 0, so the edge blends in seamlessly; d * m(d) increases for any
 * amount below 1, so nothing folds over. Sampling is bilinear on
 * premultiplied colour, so transparent surroundings leave no dark fringe.
 * Returns the pixels changed (to redraw), or null when the dab misses.
 */
export function bulgeDab(image: RgbaImage, cx: number, cy: number, radius: number, amount: number): Rect | null {
  const { width, height, pixels } = image;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(width, Math.ceil(cx + radius));
  const y1 = Math.min(height, Math.ceil(cy + radius));
  if (x0 >= x1 || y0 >= y1 || radius <= 0 || amount <= 0) return null;
  // Sources lie inside the circle, so the dab's box (plus one pixel for the
  // bilinear neighbour) is all it reads: copy it before writing.
  const sx0 = Math.max(0, x0 - 1);
  const sy0 = Math.max(0, y0 - 1);
  const sw = Math.min(width, x1 + 1) - sx0;
  const sh = Math.min(height, y1 + 1) - sy0;
  const source = new Float32Array(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = ((sy0 + y) * width + sx0 + x) * 4;
      const o = (y * sw + x) * 4;
      const a = pixels[i + 3] / 255;
      source[o] = pixels[i] * a;
      source[o + 1] = pixels[i + 1] * a;
      source[o + 2] = pixels[i + 2] * a;
      source[o + 3] = pixels[i + 3];
    }
  }
  const sample = new Float32Array(4);
  const read = (x: number, y: number, weight: number) => {
    const lx = x - sx0;
    const ly = y - sy0;
    if (lx < 0 || ly < 0 || lx >= sw || ly >= sh) return; // past the image: transparent
    const o = (ly * sw + lx) * 4;
    for (let c = 0; c < 4; c++) sample[c] += source[o + c] * weight;
  };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy) / radius;
      if (d >= 1) continue;
      const m = 1 - amount * (1 - d) * (1 - d);
      // Source position in pixel-centre coordinates.
      const px = cx + dx * m - 0.5;
      const py = cy + dy * m - 0.5;
      const fx = Math.floor(px);
      const fy = Math.floor(py);
      const tx = px - fx;
      const ty = py - fy;
      sample.fill(0);
      read(fx, fy, (1 - tx) * (1 - ty));
      read(fx + 1, fy, tx * (1 - ty));
      read(fx, fy + 1, (1 - tx) * ty);
      read(fx + 1, fy + 1, tx * ty);
      const i = (y * width + x) * 4;
      const a = sample[3];
      if (a <= 0) {
        pixels.fill(0, i, i + 4);
        continue;
      }
      const scale = 255 / a;
      pixels[i] = sample[0] * scale;
      pixels[i + 1] = sample[1] * scale;
      pixels[i + 2] = sample[2] * scale;
      pixels[i + 3] = a;
    }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Copy `source`'s pixels in `rect` back into `target` (same size): undoes a
 * bulge before it is placed again with other settings, so bulges never stack.
 */
export function restoreRect(target: RgbaImage, source: RgbaImage, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    const start = (y * target.width + rect.x) * 4;
    target.pixels.set(source.pixels.subarray(start, start + rect.width * 4), start);
  }
}

/** Which setting a press-drag changes: the radius, or (holding Shift) the strength. */
export type WarpControl = "radius" | "strength";

/**
 * One press of the warp brush: ONE bulge at the press point. A drag changes
 * the setting `mode` names — the radius from the pointer's distance to the
 * centre, the strength from its vertical movement — each relative to
 * `anchor` (the pointer and the setting's value when that mode began), so
 * a swap between the two never makes either jump.
 */
export interface WarpGesture {
  /** Where the button went down, in document px: the bulge's centre. */
  readonly center: Point;
  /** In document px. */
  readonly radius: number;
  /** In percent. */
  readonly strength: number;
  readonly mode: WarpControl;
  /** Where the current mode began: the pointer's distance and y in document px, and the setting's value then. */
  readonly anchor: { readonly distance: number; readonly y: number; readonly value: number };
  /** Moved past the drag slop: no longer a click. */
  readonly dragged: boolean;
}

/** `value` rounded to a whole number within `range`. */
function clampWhole(value: number, range: Range): number {
  return Math.max(range.min, Math.min(range.max, Math.round(value)));
}

/**
 * A press at `center` with the bar's `settings`. The radius follows the
 * pointer's distance itself (anchor 0, 0); with Shift already down the
 * press starts on the strength, from the slider's value.
 */
export function startWarpGesture(center: Point, settings: WarpSettings, shift: boolean): WarpGesture {
  return {
    center,
    radius: settings.radius,
    strength: settings.strength,
    mode: shift ? "strength" : "radius",
    anchor: { distance: 0, y: center.y, value: shift ? settings.strength : 0 },
    dragged: false,
  };
}

/**
 * The pointer moved to `at` (document px) with Shift `shift`, at view
 * `zoom` (screen px per document px). Shift is read from every pointer
 * event and acts only when it changes: holding it switches to the
 * strength, letting go back to the radius, each continuing from its
 * current value. The radius follows the pointer's distance in document px
 * (it is drawn there); the strength follows the pointer's VERTICAL
 * movement — up increases, down decreases (owner decision 2026-11-23) —
 * measured in screen px (the zoom converts the document y), so it feels
 * the same at any zoom. Both stay within their slider's range.
 */
export function moveWarpGesture(g: WarpGesture, at: Point, shift: boolean, zoom: number): WarpGesture {
  const distance = Math.hypot(at.x - g.center.x, at.y - g.center.y);
  let { mode, anchor } = g;
  const wanted: WarpControl = shift ? "strength" : "radius";
  if (wanted !== mode) {
    mode = wanted;
    // Nothing jumps: each mode re-anchors at the swap point, taking its
    // own setting's current value (the radius its distance, the strength its y).
    anchor = { distance, y: at.y, value: wanted === "strength" ? g.strength : g.radius };
  }
  const dragged = g.dragged || distance * zoom > WARP_DRAG_SLOP;
  if (!dragged) return { ...g, mode, anchor };
  return mode === "radius"
    ? { ...g, mode, anchor, dragged, radius: clampWhole(anchor.value + (distance - anchor.distance), WARP_RADIUS) }
    : {
        ...g,
        mode,
        anchor,
        dragged,
        strength: clampWhole(anchor.value - (at.y - anchor.y) * zoom * STRENGTH_PER_PX, WARP_STRENGTH),
      };
}

/** The readout beside the pointer while dragging. */
export function warpReadout(g: WarpGesture): string {
  return g.mode === "radius" ? `Radius ${g.radius} px` : `Strength ${g.strength}%`;
}

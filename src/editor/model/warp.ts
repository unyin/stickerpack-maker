// The warp/bulge brush's pixel maths (SPEC §6 "Enlarge selected parts",
// SPM-8): a dab magnifies the pixels around its centre in place, meme
// style, within its radius; pixels outside it are untouched and the image
// keeps its size, so it stays one piece. A destructive brush (owner
// decision 2026-11-21): the webview paints dabs live while the stroke
// happens (ADR-0005), and the finished stroke is ONE undo step. No Konva,
// no DOM.
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

/** Dabs along a dragged stroke, as a fraction of the radius apart. */
export const DAB_SPACING = 0.5;

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
 * The dabs a stroke drops moving from `from` (the last dab) to `to`, every
 * `spacing` along the way; `rest` is the last dab dropped (or `from`), where
 * the next move continues from.
 */
export function dabsAlong(from: Point, to: Point, spacing: number): { dabs: Point[]; rest: Point } {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const dabs: Point[] = [];
  if (spacing <= 0) return { dabs, rest: from };
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  for (let t = spacing; t <= length + 1e-9; t += spacing) dabs.push({ x: from.x + ux * t, y: from.y + uy * t });
  return { dabs, rest: dabs.at(-1) ?? from };
}

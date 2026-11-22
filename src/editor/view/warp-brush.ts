// One press of the warp/bulge brush (SPEC §6, SPM-8): ONE bulge, painted
// live into a working copy of the layer's pixels and its canvas (ADR-0005:
// no IPC while dragging). While a drag changes its radius or strength, the
// bulge is re-placed from the layer's original pixels each time, never on
// top of itself. The release hands back the new pixels for ONE undo step;
// the layer keeps its size and transform: one piece.
import { docToLocal, type Point, type RasterLayer, type Rect } from "../model/document";
import type { RgbaImage } from "../model/image";
import { bulgeDab, warpAmount } from "../model/warp";

/** The smallest rectangle holding both (either may be null). */
function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a || !b) return a ?? b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export class WarpStroke {
  /** What the layer shows while the press lasts. */
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly image: RgbaImage;
  private readonly frame: ImageData;
  /** Layer px per document px: the radius is set on screen. */
  private readonly scale: number;
  /** The pixels the last placement changed (restored before the next). */
  private placed: Rect | null = null;

  constructor(readonly layer: RasterLayer) {
    const { width, height, pixels } = layer.image;
    this.image = { width, height, pixels: new Uint8ClampedArray(pixels) };
    this.frame = new ImageData(this.image.pixels, width, height);
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("this webview cannot draw 2D canvases");
    this.context = context;
    context.putImageData(this.frame, 0, 0);
    const t = layer.transform;
    this.scale = 1 / Math.sqrt(Math.abs(t.scaleX * t.scaleY));
  }

  /** Place the bulge at `center` (document px) with `radius` (document px) and `strength` (percent), replacing the last one. */
  place(center: Point, radius: number, strength: number): void {
    const previous = this.placed;
    if (previous) this.restore(previous);
    const p = docToLocal(this.layer.transform, center);
    this.placed = bulgeDab(this.image, p.x, p.y, radius * this.scale, warpAmount(strength));
    const dirty = union(previous, this.placed);
    if (dirty) this.context.putImageData(this.frame, 0, 0, dirty.x, dirty.y, dirty.width, dirty.height);
  }

  /** The new pixels, or null when the bulge missed the layer. */
  finish(): RgbaImage | null {
    return this.placed ? this.image : null;
  }

  /** Put the layer's original pixels back in `rect`. */
  private restore(rect: Rect): void {
    const { width } = this.image;
    const source = this.layer.image.pixels;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      const start = (y * width + rect.x) * 4;
      this.image.pixels.set(source.subarray(start, start + rect.width * 4), start);
    }
  }
}

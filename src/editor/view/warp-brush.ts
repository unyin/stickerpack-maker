// One warp/bulge stroke (SPEC §6, SPM-8): dabs paint into a working copy
// of the layer's pixels and its canvas while the stroke happens (ADR-0005:
// no IPC per dab), and the finished stroke hands back the new pixels for
// ONE undo step. The layer keeps its size and transform: one piece.
import { docToLocal, type Point, type RasterLayer } from "../model/document";
import type { RgbaImage } from "../model/image";
import { bulgeDab, DAB_SPACING, dabsAlong, warpAmount, type WarpSettings } from "../model/warp";

export class WarpStroke {
  /** What the layer shows while the stroke happens. */
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly image: RgbaImage;
  private readonly frame: ImageData;
  /** The brush in the layer's own pixels: radius and dab spacing. */
  private readonly radius: number;
  private readonly amount: number;
  private last: Point | null = null;
  private changed = false;

  constructor(
    readonly layer: RasterLayer,
    settings: WarpSettings,
  ) {
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
    // The radius is set in document px: on a scaled layer it covers the same area on screen.
    const t = layer.transform;
    this.radius = settings.radius / Math.sqrt(Math.abs(t.scaleX * t.scaleY));
    this.amount = warpAmount(settings.strength);
  }

  /** The button went down at `at` (document px): one dab there. */
  press(at: Point): void {
    const p = docToLocal(this.layer.transform, at);
    this.dab(p);
    this.last = p;
  }

  /** The pointer moved to `at` while pressed: dabs every half radius along the way. */
  move(at: Point): void {
    if (!this.last) return;
    const { dabs, rest } = dabsAlong(this.last, docToLocal(this.layer.transform, at), this.radius * DAB_SPACING);
    for (const p of dabs) this.dab(p);
    this.last = rest;
  }

  /** The stroke's pixels, or null when no dab touched the layer. */
  finish(): RgbaImage | null {
    return this.changed ? this.image : null;
  }

  private dab(p: Point): void {
    const dirty = bulgeDab(this.image, p.x, p.y, this.radius, this.amount);
    if (!dirty) return;
    this.changed = true;
    this.context.putImageData(this.frame, 0, 0, dirty.x, dirty.y, dirty.width, dirty.height);
  }
}

// The Konva view of an editing session (ADR-0005): it draws the model and
// turns gestures into model operations. It never holds state the model
// lacks, so undo/redo and save never read from Konva.
import Konva from "konva";
import type { RgbaImage } from "../model/image";
import {
  contentBounds,
  layerImage,
  setTransform,
  type Doc,
  type Layer,
  type Point,
  type Rect,
  type Transform,
} from "../model/document";
import { lassoRegion, rectRegion, type Region } from "../model/region";
import { effectKindOf } from "../model/effects";
import { backgroundTarget, restoreBlocker } from "../model/background";
import { beginStroke, BRUSH_SIZE, finishStroke, strokeTo, type BrushMode, type Stroke } from "../model/brush";
import type { EditorSession } from "../model/session";
import type { CanvasTool } from "../model/tools";
import { fitView, panView, selectModeFor, zoomAround, type ViewTransform } from "./geometry";
import { distance, lassoDoubleClick, lassoDrag, lassoPress, lassoPreview, lassoRelease, lassoUndo, type LassoDraft } from "./lasso";

function isBrushTool(tool: CanvasTool): tool is BrushMode {
  return tool === "erase" || tool === "restore";
}

/**
 * The warp brush's side of a press, in document px (SPM-8). `shift` is the
 * pointer event's own shiftKey, as Konva's Transformer reads it.
 */
export interface BrushHandler {
  press(at: Point, shift: boolean): void;
  move(at: Point, shift: boolean): void;
  release(): void;
}

/** A warp press being dragged: its bulge's centre and radius, and the readout beside the pointer. */
export interface BrushGesture {
  readonly center: Point;
  readonly radius: number;
  readonly readout: string;
}

/**
 * What a layer shows instead of its own pixels for a while: an effect
 * preview (pixels plus where they go) or a warp press in progress (its
 * live canvas). Never part of the model (ADR-0005, CMT-186).
 */
export interface LayerOverride {
  readonly id: string;
  readonly image: RgbaImage | HTMLCanvasElement;
  readonly transform: Transform;
}

/** The effect tools with a preview, where the canvas only pans (SPM-8). */
function hasPreview(tool: CanvasTool): boolean {
  return effectKindOf(tool) !== null;
}

/** Screen px between the pointer and the warp readout's top-left. */
const READOUT_OFFSET = 14;

/** The pick loupe (SPM-8, CMT-296): its side in screen px, and the canvas px it magnifies. */
const LOUPE_SIDE = 120;
const LOUPE_CROP = 24;

/** Why a pick on a fully transparent spot does nothing; the pick stays for another try (owner-vetoable copy). */
const NOTHING_TO_PICK = "Nothing to pick there: that spot is fully transparent.";

/** A pixel as lowercase #rrggbb. */
function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Lasso points closer than this many screen px to the previous one are skipped. */
const LASSO_STEP = 2;
/** A lasso press (or freehand release) this close to its start point, in screen px, closes it. */
const LASSO_CLOSE_RADIUS = 8;
/** A lasso press that travels more than this, in screen px, is a freehand stroke, not a click (Windows' drag threshold). */
const LASSO_DRAG_SLOP = 4;
/** A press this soon after a lasso closed, on the same spot, is that double-click's second press. */
const DOUBLE_CLICK_MS = 500;

/** Canvas per pixel buffer: pixels are immutable, so a buffer draws once. */
const canvases = new WeakMap<RgbaImage, HTMLCanvasElement>();

function canvasFor(image: RgbaImage): HTMLCanvasElement {
  const cached = canvases.get(image);
  if (cached) return cached;
  const canvas = drawCanvas(image);
  canvases.set(image, canvas);
  return canvas;
}

/** A new canvas showing `image` (uncached: a brush stroke paints into its own). */
function drawCanvas(image: RgbaImage): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  context2d(canvas).putImageData(new ImageData(image.pixels, image.width, image.height), 0, 0);
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("this webview cannot draw 2D canvases");
  return context;
}

/** A copy of the pixels of `image` inside `r`, to redraw just what a brush step changed. */
function regionData(image: RgbaImage, r: Rect): ImageData {
  const data = new ImageData(r.width, r.height);
  for (let row = 0; row < r.height; row++) {
    const from = ((r.y + row) * image.width + r.x) * 4;
    data.data.set(image.pixels.subarray(from, from + r.width * 4), row * r.width * 4);
  }
  return data;
}

/** A light checkerboard tile showing transparency on the document area. */
function checkerTile(light: string, dark: string): HTMLCanvasElement {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 16;
  const context = tile.getContext("2d");
  if (context) {
    context.fillStyle = light;
    context.fillRect(0, 0, 16, 16);
    context.fillStyle = dark;
    context.fillRect(0, 0, 8, 8);
    context.fillRect(8, 8, 8, 8);
  }
  return tile;
}

/**
 * Reads a shared design token from src/styles.css. Konva draws to a canvas, so
 * CSS cannot restyle it: the stage re-reads these whenever the theme changes.
 */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function transformOf(node: Konva.Node): Transform {
  return {
    x: node.x(),
    y: node.y(),
    scaleX: node.scaleX(),
    scaleY: node.scaleY(),
    rotation: node.rotation(),
  };
}

function sameTransform(a: Transform, b: Transform): boolean {
  return (
    a.x === b.x && a.y === b.y && a.scaleX === b.scaleX && a.scaleY === b.scaleY && a.rotation === b.rotation
  );
}

const FIT_MARGIN = 24;

export class EditorStage {
  private readonly stage: Konva.Stage;
  private readonly content = new Konva.Layer();
  private readonly backdrop: Konva.Rect;
  /** Non-interactive layer drawn above the content: the canvas outline and the crop box. */
  private readonly guides = new Konva.Layer({ listening: false });
  private readonly outline: Konva.Rect;
  /**
   * The crop box overlay (SPEC §6), drawn at the rectangle the view hands
   * `setCropBox` (the one Crop keeps). A solid halo under a dashed line keeps
   * it visible over any image.
   */
  private readonly boxHalo = new Konva.Rect({ strokeWidth: 3, strokeScaleEnabled: false, listening: false });
  private readonly box = new Konva.Rect({
    strokeWidth: 1,
    dash: [6, 4],
    strokeScaleEnabled: false,
    listening: false,
  });
  // Konva never holds state the model lacks (ADR-0005): the model's Transform
  // has no skew and no flips, and SPEC §6 needs only aspect-preserving resize
  // plus rotate. So only the corner anchors exist, ratio is kept, flips off.
  private readonly transformer = new Konva.Transformer({
    enabledAnchors: ["top-left", "top-right", "bottom-left", "bottom-right"],
    rotateEnabled: true,
    keepRatio: true,
    flipEnabled: false,
    ignoreStroke: true,
  });
  /** The cut selection (session.region, or the one being drawn): a halo under a dashed line. */
  private readonly regionHalo = new Konva.Line({ closed: true, strokeWidth: 3, strokeScaleEnabled: false, listening: false });
  private readonly regionLine = new Konva.Line({
    closed: true,
    strokeWidth: 1,
    dash: [4, 4],
    strokeScaleEnabled: false,
    listening: false,
  });
  /** The warp brush's outline under the pointer (SPM-8). */
  private readonly warpRing = new Konva.Circle({ strokeWidth: 1, strokeScaleEnabled: false, listening: false, visible: false });
  /** The radius or strength readout beside the pointer while a warp press is dragged. */
  private readonly readout = new Konva.Label({ listening: false, visible: false });
  private readonly readoutTag = new Konva.Tag({ cornerRadius: 4, strokeWidth: 1, strokeScaleEnabled: false });
  private readonly readoutText = new Konva.Text({ padding: 4, fontSize: 13 });
  /** The loupe's pixels, redrawn per frame while picking. */
  private readonly loupeCanvas = document.createElement("canvas");
  /**
   * The colour pick's magnifier (SPM-8, CMT-296): the zoomed pixels around
   * the pointer with the hex under it. In the guides layer, so a read of
   * the composite never sees the loupe itself.
   */
  private readonly loupe = new Konva.Group({ listening: false, visible: false });
  private readonly loupeShot = new Konva.Image({ image: this.loupeCanvas, width: LOUPE_SIDE, height: LOUPE_SIDE, strokeWidth: 1, strokeScaleEnabled: false, listening: false });
  private readonly loupeLabel = new Konva.Label({ y: LOUPE_SIDE, listening: false });
  private readonly loupeTag = new Konva.Tag({ cornerRadius: 4, strokeWidth: 1, strokeScaleEnabled: false });
  private readonly loupeText = new Konva.Text({ padding: 4, fontSize: 13, align: "center" });
  /** A loupe redraw scheduled for the next animation frame (pointer moves coalesce). */
  private loupeFrame = 0;
  /** The colour pick in progress, if any: where its sample lands (CMT-296). */
  private pick: { readonly apply: (hex: string) => void } | null = null;
  private pickBlocked?: (reason: string) => void;
  /** The press the pick consumed, so its click selects nothing (the flag is cleared by the click). */
  private pickConsumedClick = false;
  private brush?: BrushHandler;
  private brushing = false;
  /** The warp press being dragged, which the ring follows instead of the pointer. */
  private gesture: BrushGesture | null = null;
  private brushRadius = 0;
  private override: LayerOverride | null = null;
  /** The refine brush's outline at the pointer (SPM-7): a halo under a thin ring, sized in canvas px. */
  private readonly brushHalo = new Konva.Circle({ radius: BRUSH_SIZE.initial / 2, strokeWidth: 3, strokeScaleEnabled: false, listening: false, visible: false });
  private readonly brushRing = new Konva.Circle({ radius: BRUSH_SIZE.initial / 2, strokeWidth: 1, strokeScaleEnabled: false, listening: false, visible: false });
  private readonly nodes = new Map<string, Konva.Image>();
  private readonly pending = new Set<string>();
  private readonly resizeObserver: ResizeObserver;
  /** Watches <html data-theme> (set by src/theme.ts) to recolour the canvas. */
  private readonly themeObserver = new MutationObserver(() => this.applyTheme());
  private readonly unsubscribe: () => void;
  /** The middle-button pan in progress, if any: the view and pointer when it began. */
  private middlePan: { view: ViewTransform; pointer: Point } | null = null;
  private readonly onMiddleDown = (e: MouseEvent): void => this.beginMiddlePan(e);
  private readonly onMiddleMove = (e: MouseEvent): void => this.moveMiddlePan(e);
  private readonly onMiddleUp = (e: MouseEvent): void => {
    if (e.button === 1) this.middlePan = null;
  };
  private readonly onAuxClick = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };
  private viewChanged?: (view: ViewTransform) => void;
  private brushBlocked?: (reason: string) => void;
  /** The refine brush's diameter in canvas px. */
  private brushSize: number = BRUSH_SIZE.initial;
  /** The brush stroke in progress and the canvas it paints live (its layer's node shows it). */
  private stroke: { readonly stroke: Stroke; readonly canvas: HTMLCanvasElement } | null = null;
  private editText?: (id: string) => void;
  private tool: CanvasTool = "move";
  private interactive = true;
  /** The text layer whose overlay editor is open: its node is hidden meanwhile. */
  private editing: string | null = null;
  /** The rectangle being dragged, in document px. */
  private rectDrag: { start: Point; end: Point } | null = null;
  /** The lasso being drawn (it stays open between presses). */
  private lasso: LassoDraft | null = null;
  /** Where and when the last lasso closed (to swallow the second press of a closing double-click). */
  private lassoClosed: { at: Point; time: number } | null = null;
  /** Only the left button (or a touch) ends a drag: a middle-button pan mid-drag leaves it be. */
  private readonly onRelease = (e: MouseEvent | TouchEvent): void => {
    if (e instanceof MouseEvent && e.button !== 0) return;
    this.releaseRegion();
    this.releaseBrush();
  };
  /**
   * Whether the view is settled: fitted once, or zoomed/panned by the user.
   * Until then a 0×0 host defers the first fit to resize().
   */
  private fitted = false;

  constructor(
    private readonly container: HTMLDivElement,
    private readonly session: EditorSession,
  ) {
    this.stage = new Konva.Stage({
      container,
      width: container.clientWidth || 1,
      height: container.clientHeight || 1,
      // Dragging empty space pans the view; dragging a layer moves it.
      draggable: true,
    });
    // Checkerboard under the layers shows transparency...
    this.backdrop = new Konva.Rect({ listening: false });
    // ...while guides sit ABOVE every layer, so covering layers never hide
    // them (owner, 2026-11-20): the canvas outline and the crop box.
    this.outline = new Konva.Rect({
      strokeWidth: 1,
      strokeScaleEnabled: false,
      listening: false,
    });
    this.guides.add(this.outline, this.boxHalo, this.box, this.regionHalo, this.regionLine, this.brushHalo, this.brushRing, this.warpRing, this.readout, this.loupe);
    this.readout.add(this.readoutTag, this.readoutText);
    this.loupeCanvas.width = LOUPE_SIDE;
    this.loupeCanvas.height = LOUPE_SIDE;
    this.loupe.add(this.loupeShot, this.loupeLabel);
    this.loupeLabel.add(this.loupeTag, this.loupeText);
    this.content.add(this.backdrop);
    this.content.add(this.transformer);
    this.stage.add(this.content);
    this.stage.add(this.guides);

    // Middle-drag pans anywhere, over layers too. Capture phase on the host
    // runs before Konva sees the press, so no layer is selected or moved.
    container.addEventListener("mousedown", this.onMiddleDown, true);
    container.addEventListener("auxclick", this.onAuxClick, true);
    window.addEventListener("mousemove", this.onMiddleMove);
    window.addEventListener("mouseup", this.onMiddleUp);
    this.stage.on("wheel", (e) => this.onWheel(e));
    this.stage.on("dragmove dragend", (e) => {
      if (e.target !== this.stage) return;
      // Konva has already moved the stage: only mark it hand-moved and notify.
      if (e.type === "dragend") this.fitted = true;
      this.viewChanged?.(this.view());
    });
    this.stage.on("click tap", (e) => {
      if (this.pickConsumedClick) {
        this.pickConsumedClick = false; // the pick owned the press this click came from
        return;
      }
      if (e.target === this.stage && this.tool === "move") this.session.clearSelection();
    });
    this.stage.on("mousedown touchstart", (e) => {
      if (e.evt instanceof MouseEvent && e.evt.button !== 0) return;
      // A colour pick owns the left button in every tool (SPM-8, CMT-296).
      if (this.pick) return this.pressPick();
      this.pickConsumedClick = false; // a fresh press: its own click is not the pick's
      // Shift is read from the event itself (SPM-8: it sets a warp drag's strength).
      this.pressRegion(e.evt instanceof MouseEvent ? e.evt.shiftKey : false);
      this.pressBrush();
    });
    this.stage.on("mousemove touchmove", (e) => {
      if (this.pick) return this.scheduleLoupe();
      this.extendRegion(e.evt instanceof MouseEvent ? e.evt.shiftKey : false);
      this.moveBrush();
    });
    this.stage.on("mouseleave", () => {
      this.placeWarpRing(null);
      this.showBrushAt(null);
      if (this.pick) {
        this.loupe.visible(false);
        this.guides.batchDraw();
      }
    });
    this.stage.on("dblclick dbltap", () => {
      if (!this.interactive || this.tool !== "lasso" || !this.lasso) return;
      const step = lassoDoubleClick(this.lasso, this.docPx(LASSO_CLOSE_RADIUS));
      this.lasso = step.draft;
      if (step.close) this.closeLasso(true);
    });
    // Released anywhere, even outside the canvas, a drag ends.
    window.addEventListener("mouseup", this.onRelease);
    window.addEventListener("touchend", this.onRelease);

    this.applyTheme();
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.unsubscribe = session.subscribe(() => this.render());
    this.render();
    // The one automatic fit: when the session opens. A detached or 0×0 host
    // (e.g. another view showing) defers it to the first real resize().
    this.fit();
  }

  /** Called with the current zoom/pan whenever it changes. */
  onViewChange(listener: (view: ViewTransform) => void): void {
    this.viewChanged = listener;
    listener(this.view());
  }

  view(): ViewTransform {
    return { scale: this.stage.scaleX(), x: this.stage.x(), y: this.stage.y() };
  }

  /** Called with a text layer's id when it is double-clicked (to edit its text). */
  onEditText(listener: (id: string) => void): void {
    this.editText = listener;
  }

  /**
   * The whole image's bounds in document pixels: the union of every layer's
   * on-screen box, text by its Rust-rendered box (CMT-61). All three sizing
   * tools scale this.
   */
  contentBounds(): Rect {
    return contentBounds(this.session.doc);
  }

  /** Choose what the left button does on the canvas (SPM-9, SPM-7, SPM-8). */
  setTool(tool: CanvasTool): void {
    this.endPick(); // a pick never outlives the state it started in
    if (this.brushing) this.releaseWarp();
    this.tool = tool;
    this.rectDrag = null;
    this.lasso = null;
    this.stroke = null;
    this.container.style.cursor = isBrushTool(tool) ? "crosshair" : "";
    if (!isBrushTool(tool)) this.showBrushAt(null);
    if (tool !== "warp") this.placeWarpRing(null);
    this.applyListening();
    this.render();
  }

  /** The refine brush's diameter in canvas px (SPM-7). */
  setBrushSize(size: number): void {
    this.brushSize = size;
    this.brushHalo.radius(size / 2);
    this.brushRing.radius(size / 2);
    this.guides.batchDraw();
  }

  /** Called with the reason when a brush press cannot paint (no image layer, nothing to restore). */
  onBrushBlocked(listener: (reason: string) => void): void {
    this.brushBlocked = listener;
  }

  /** Called with the reason when a pick clicks a fully transparent spot (the pick stays for another try). */
  onPickBlocked(listener: (reason: string) => void): void {
    this.pickBlocked = listener;
  }

  /**
   * True while a pixel-changing press is in progress: a refine stroke
   * (Erase/Restore, SPM-7) or a warp gesture (Warp, SPM-8). Its pixels are
   * painted live but reach the model only at release, so Save is refused
   * until the press ends (owner decision 2026-11-23).
   */
  strokeInProgress(): boolean {
    return this.stroke !== null || this.brushing;
  }

  /**
   * A key for the lasso in progress (SPM-9): Enter closes it, Escape cancels
   * it, Backspace removes its last segment (a waypoint or a whole freehand
   * stroke). True when the key was used, so the Editor's own shortcuts (Esc
   * dropping the selection) do not also run.
   */
  handleLassoKey(key: string): boolean {
    if (!this.lasso) return false;
    if (key === "Enter") this.closeLasso();
    else if (key === "Escape") this.lasso = null;
    else if (key === "Backspace") this.lasso = lassoUndo(this.lasso);
    else return false;
    this.drawRegion();
    return true;
  }

  /**
   * A key for the colour pick in progress (SPM-8, CMT-296): Escape cancels
   * it, restoring the tool's own state. True when the key was used, so the
   * Editor's own Esc (dropping the selection, ending an effect tool) does
   * not also run.
   */
  handlePickKey(key: string): boolean {
    if (!this.pick || key !== "Escape") return false;
    this.endPick();
    return true;
  }

  /** Paint with `handler` while the warp tool is active (SPM-8). */
  onBrush(handler: BrushHandler): void {
    this.brush = handler;
  }

  /** The warp brush's radius in document px, for the ring under the pointer. */
  setBrushRadius(radius: number): void {
    this.brushRadius = radius;
    if (!this.gesture) this.warpRing.radius(radius);
    this.guides.batchDraw();
  }

  /**
   * Show a warp press being dragged: the ring around its bulge and the
   * readout beside the pointer; null goes back to the ring under the pointer.
   */
  setBrushGesture(gesture: BrushGesture | null): void {
    this.gesture = gesture;
    const pointer = this.pointer();
    if (gesture) {
      this.warpRing.radius(gesture.radius);
      this.warpRing.position(gesture.center);
      this.warpRing.visible(true);
      this.readoutText.text(gesture.readout);
      // Constant size on screen at any zoom, just below-right of the pointer.
      const k = 1 / this.stage.scaleX();
      this.readout.scale({ x: k, y: k });
      if (pointer) this.readout.position({ x: pointer.x + READOUT_OFFSET * k, y: pointer.y + READOUT_OFFSET * k });
    }
    this.readout.visible(gesture !== null);
    if (!gesture) this.placeWarpRing(pointer);
    this.guides.batchDraw();
  }

  /** Show other pixels for one layer (an effect preview, a warp press), or (null) every layer as it is. */
  setOverride(override: LayerOverride | null): void {
    if (override === this.override) return;
    this.override = override;
    this.render();
  }

  /** Redraw after a warp press painted into the override's canvas. */
  redraw(): void {
    this.content.batchDraw();
  }

  /** Hide a text layer while its text is edited in the overlay (null shows it again). */
  setEditing(id: string | null): void {
    this.editing = id;
    this.render();
  }

  /**
   * Centre the document and zoom to fit it (never above 100%). Runs once
   * when the stage opens (deferred while the host is 0×0) and on Reset view;
   * editing, sizing tools included, never moves the view.
   */
  fit(): void {
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth === 0 || clientHeight === 0) return; // stays deferred to resize()
    const doc = this.session.doc;
    this.setView(fitView({ width: this.stage.width(), height: this.stage.height() }, doc, FIT_MARGIN));
    this.fitted = true;
  }

  /** Place the crop box overlay; the view computes the box once per refresh and passes it here. */
  setCropBox(box: Rect): void {
    this.boxHalo.setAttrs(box);
    this.box.setAttrs(box);
    this.guides.batchDraw();
  }

  /**
   * Show or hide the crop guides, the crop box overlay and the canvas outline
   * together (on when the stage opens). In v1 the canvas never exceeds the
   * constraint side (it starts at the side, and only Fit and Longest side
   * change it, never above the side), so the capped box equals the canvas and
   * they are one guide; the checkerboard still shows where the canvas is (SPEC §6).
   */
  setCropGuidesVisible(visible: boolean): void {
    this.outline.visible(visible);
    this.boxHalo.visible(visible);
    this.box.visible(visible);
    this.guides.batchDraw();
  }

  /**
   * Suspend or resume all pointer interaction (layers, selection, panning),
   * so nothing is edited while an async operation works from a snapshot.
   */
  setInteractive(enabled: boolean): void {
    this.interactive = enabled;
    if (!enabled) this.middlePan = null; // ends a middle pan as Konva ends a left drag
    this.applyListening();
  }

  /** Layers listen only with the Move tool and while nothing is picked; empty space pans with it and the effect tools; nothing while not interactive. */
  private applyListening(): void {
    // While a colour pick runs it owns the left button: no layer is
    // selected or moved, and a left-drag does not pan (the pick samples on
    // the press, so nothing smears). Wheel zoom and middle-drag pan stay.
    const picking = this.pick !== null;
    this.content.listening(this.interactive && !picking && this.tool === "move");
    this.stage.draggable(this.interactive && !picking && (this.tool === "move" || hasPreview(this.tool)));
    this.content.batchDraw();
  }

  destroy(): void {
    this.endPick(); // a pick never outlives the state it started in
    window.removeEventListener("mouseup", this.onRelease);
    window.removeEventListener("touchend", this.onRelease);
    this.container.removeEventListener("mousedown", this.onMiddleDown, true);
    this.container.removeEventListener("auxclick", this.onAuxClick, true);
    window.removeEventListener("mousemove", this.onMiddleMove);
    window.removeEventListener("mouseup", this.onMiddleUp);
    this.unsubscribe();
    this.themeObserver.disconnect();
    this.resizeObserver.disconnect();
    this.stage.destroy();
  }

  /** Take the canvas colours (checkerboard, outline, transformer) from the current theme's tokens. */
  private applyTheme(): void {
    this.backdrop.fillPatternImage(checkerTile(token("--panel"), token("--border")) as unknown as HTMLImageElement);
    this.outline.stroke(token("--muted"));
    this.boxHalo.stroke(token("--panel"));
    this.box.stroke(token("--accent-ink"));
    this.transformer.borderStroke(token("--accent-ink"));
    this.transformer.anchorStroke(token("--accent-ink"));
    this.transformer.anchorFill(token("--panel"));
    this.regionHalo.stroke(token("--panel"));
    this.regionLine.stroke(token("--accent-ink"));
    this.warpRing.stroke(token("--accent-ink"));
    this.readoutTag.fill(token("--panel"));
    this.readoutTag.stroke(token("--border"));
    this.readoutText.fill(token("--text"));
    this.loupeShot.stroke(token("--accent-ink"));
    this.loupeTag.fill(token("--panel"));
    this.loupeTag.stroke(token("--border"));
    this.loupeText.fill(token("--text"));
    this.brushHalo.stroke(token("--panel"));
    this.brushRing.stroke(token("--accent-ink"));
    this.content.batchDraw();
    this.guides.batchDraw();
  }

  private setView(view: ViewTransform): void {
    this.stage.scale({ x: view.scale, y: view.scale });
    this.stage.position({ x: view.x, y: view.y });
    this.viewChanged?.(view);
  }

  /** A view the user moved by hand: it is never overwritten by an automatic fit. */
  private setHandView(view: ViewTransform): void {
    this.setView(view);
    this.fitted = true;
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth === 0 || clientHeight === 0) return; // detached (other tab)
    this.stage.size({ width: clientWidth, height: clientHeight });
    if (!this.fitted) this.fit(); // later resizes keep the view
  }

  /** The pointer in document pixels. */
  private pointer(): Point | null {
    return this.content.getRelativePointerPosition();
  }

  /** Screen px as document px at the current zoom. */
  private docPx(screenPx: number): number {
    return screenPx / this.stage.scaleX();
  }

  private pressRegion(shift: boolean): void {
    if (this.tool === "warp") {
      if (!this.interactive) return;
      const at = this.pointer();
      if (!at) return;
      this.brushing = true;
      this.brush?.press(at, shift);
      return;
    }
    if ((this.tool !== "rect" && this.tool !== "lasso") || !this.interactive) return;
    const at = this.pointer();
    if (!at) return;
    if (this.tool === "rect") this.rectDrag = { start: at, end: at };
    else {
      const radius = this.docPx(LASSO_CLOSE_RADIUS);
      if (!this.lasso && this.justClosedAt(at, radius)) return; // a closing double-click's second press
      const step = lassoPress(this.lasso, at, radius);
      this.lasso = step.draft;
      if (step.close) return this.closeLasso(true);
    }
    this.drawRegion();
  }

  private extendRegion(shift: boolean): void {
    const at = this.pointer();
    if (!at) return;
    if (this.tool === "warp") {
      if (this.brushing) this.brush?.move(at, shift);
      else this.placeWarpRing(at);
      return;
    }
    if (this.rectDrag) this.rectDrag = { ...this.rectDrag, end: at };
    else if (this.lasso) this.lasso = lassoDrag(this.lasso, at, this.docPx(LASSO_STEP), this.docPx(LASSO_DRAG_SLOP));
    else return;
    this.drawRegion(); // between lasso presses this moves the rubber band
  }

  /** The left button went up: a rectangle drag ends; a lasso closes only when released on its start. */
  private releaseRegion(): void {
    if (this.brushing) return this.releaseWarp();
    const rect = this.rectDrag;
    if (rect) {
      this.rectDrag = null;
      return this.commitRegion(rectRegion(rect.start, rect.end));
    }
    if (!this.lasso?.pressed) return;
    const at = this.pointer() ?? this.lasso.points[this.lasso.points.length - 1];
    const step = lassoRelease(this.lasso, at, this.docPx(LASSO_CLOSE_RADIUS));
    this.lasso = step.draft;
    if (step.close) this.closeLasso();
    else this.drawRegion();
  }

  /** The left button went up (or the tool changed): a warp press ends as one step. */
  private releaseWarp(): void {
    this.brushing = false;
    this.brush?.release();
  }

  /** Show the warp brush's ring at `at` (document px), or hide it. */
  private placeWarpRing(at: Point | null): void {
    if (this.gesture) return; // the ring stays on the press being dragged
    this.warpRing.radius(this.brushRadius);
    this.warpRing.visible(at !== null && this.tool === "warp");
    if (at) this.warpRing.position(at);
    this.guides.batchDraw();
  }

  /** True when a lasso closed at `at` (within `radius`) a moment ago. */
  private justClosedAt(at: Point, radius: number): boolean {
    const closed = this.lassoClosed;
    if (!closed || performance.now() - closed.time >= DOUBLE_CLICK_MS) return false;
    return distance(at, closed.at) <= radius;
  }

  /**
   * Close the lasso in progress: its polygon becomes the cut selection (none,
   * if it has no area). A close `byPointer` (a press on the start point or a
   * double-click) is remembered, to swallow the double-click's second press.
   */
  private closeLasso(byPointer = false): void {
    const points = this.lasso?.points ?? [];
    this.lasso = null;
    const at = byPointer ? this.pointer() : null;
    this.lassoClosed = at ? { at, time: performance.now() } : null;
    this.commitRegion(lassoRegion(points));
  }

  /** A finished drawing becomes the session's region (or none, for a click or no area). */
  private commitRegion(region: Region | null): void {
    if (region === this.session.region) this.drawRegion();
    else this.session.setRegion(region);
  }

  /** Draw the selection being drawn, else the session's region. */
  private drawRegion(): void {
    let points: readonly Point[] = this.session.region?.points ?? [];
    let closed = true;
    if (this.rectDrag) {
      const { start, end } = this.rectDrag;
      points = [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }];
    } else if (this.lasso) {
      points = lassoPreview(this.lasso, this.pointer());
      closed = false;
    }
    const flat = points.flatMap((p) => [p.x, p.y]);
    for (const line of [this.regionHalo, this.regionLine]) {
      line.points(flat);
      line.closed(closed);
      line.visible(points.length > 1);
    }
    this.guides.batchDraw();
  }

  // ---- Refine brush (SPM-7): paints live, one undo step per finished stroke ----

  /**
   * A left press with Erase or Restore starts a stroke on the background
   * tools' target (the selected image layer, or the base image), or says
   * why it cannot.
   */
  private pressBrush(): void {
    if (!isBrushTool(this.tool) || !this.interactive) return;
    const at = this.pointer();
    if (!at) return;
    const target = backgroundTarget(this.session.doc, this.session.selection);
    if ("reason" in target) return this.brushBlocked?.(target.reason);
    const blocked = this.tool === "restore" ? restoreBlocker(target.layer) : null;
    if (blocked) return this.brushBlocked?.(blocked);
    const stroke = beginStroke(target.layer, this.tool, this.brushSize);
    this.stroke = { stroke, canvas: drawCanvas(stroke.working) };
    this.render(); // the layer's node now shows the stroke's canvas
    this.paintBrush(at);
  }

  private moveBrush(): void {
    if (!isBrushTool(this.tool)) return;
    const at = this.pointer();
    this.showBrushAt(at);
    if (at && this.stroke) this.paintBrush(at);
  }

  private paintBrush(at: Point): void {
    const live = this.stroke;
    if (!live) return;
    const dirty = strokeTo(live.stroke, at);
    if (!dirty) return;
    context2d(live.canvas).putImageData(regionData(live.stroke.working, dirty), dirty.x, dirty.y);
    this.content.batchDraw();
  }

  /** The left button went up: a stroke that changed pixels becomes ONE undo step. */
  private releaseBrush(): void {
    const live = this.stroke;
    if (!live) return;
    this.stroke = null;
    // The painted canvas already shows the new pixels: reuse it, no redraw.
    if (live.stroke.changed) canvases.set(live.stroke.working, live.canvas);
    this.session.apply((doc) => finishStroke(doc, live.stroke));
    this.render(); // a stroke that changed nothing shows the layer's own canvas again
  }

  /** Show the brush outline centred on `at` (document px), or hide it (null). */
  private showBrushAt(at: Point | null): void {
    const visible = at !== null && isBrushTool(this.tool);
    for (const ring of [this.brushHalo, this.brushRing]) {
      ring.visible(visible);
      if (at) ring.position(at);
    }
    this.guides.batchDraw();
  }

  // ---- Colour pick (SPM-8, CMT-296): canvas-only, crosshair plus loupe ----

  /**
   * Start a colour pick from the canvas: the pointer becomes a crosshair
   * with a magnifier loupe, the pick owns the left button in every tool,
   * and a click samples the composited pixel under it into `apply`. Esc,
   * switching tools or ending the session cancels; a fully transparent
   * spot refuses, saying why, and the pick stays for another try.
   */
  beginColorPick(apply: (hex: string) => void): void {
    this.endPick();
    this.pick = { apply };
    this.container.style.cursor = "crosshair";
    // The tool's own pointer furniture yields to the pick's.
    this.showBrushAt(null);
    this.placeWarpRing(null);
    this.applyListening();
    this.scheduleLoupe();
  }

  /** End the colour pick, restoring the tool's own pointer state. */
  private endPick(): void {
    if (this.loupeFrame) {
      cancelAnimationFrame(this.loupeFrame);
      this.loupeFrame = 0;
    }
    if (!this.pick) return;
    this.pick = null;
    this.loupe.visible(false);
    this.container.style.cursor = isBrushTool(this.tool) ? "crosshair" : "";
    this.applyListening();
    this.guides.batchDraw();
  }

  /**
   * A left press while picking: sample the composited pixel under the
   * pointer ONCE (a drag has nothing to smear; the pick is over). A fully
   * transparent spot refuses and the pick stays.
   */
  private pressPick(): void {
    if (!this.interactive) return; // as every press: nothing happens while an action works
    this.pickConsumedClick = true; // the click this press becomes selects nothing
    const shot = this.compositeAround();
    if (!shot) return;
    const pixel = context2d(shot.canvas).getImageData(shot.x, shot.y, 1, 1).data;
    if (pixel[3] === 0) {
      this.pickBlocked?.(NOTHING_TO_PICK);
      return;
    }
    const apply = this.pick?.apply;
    this.endPick();
    apply?.(hexOf(pixel[0], pixel[1], pixel[2]));
  }

  /**
   * The composited pixels as shown, in a LOUPE_CROP square around the
   * pointer: every document layer and any visible effect preview, with
   * every piece of furniture hidden around the read - the guides layer
   * (crop box, region, rings, the readout, the loupe itself), the
   * transformer's handles and the checkerboard backdrop - so a guide never
   * samples and a fully transparent spot stays transparent. `x`/`y` are
   * the pointer's pixel within the returned canvas; null while the pointer
   * is off the canvas.
   */
  private compositeAround(): { canvas: HTMLCanvasElement; x: number; y: number } | null {
    const pointer = this.stage.getPointerPosition();
    if (!pointer) return null;
    const left = Math.round(pointer.x - LOUPE_CROP / 2);
    const top = Math.round(pointer.y - LOUPE_CROP / 2);
    // The hide-and-read is synchronous: the screen never paints the furniture hidden.
    const hidden: Konva.Node[] = [this.backdrop, this.transformer, this.guides];
    for (const node of hidden) node.visible(false);
    try {
      const canvas = this.stage.toCanvas({ x: left, y: top, width: LOUPE_CROP, height: LOUPE_CROP, pixelRatio: 1 });
      return { canvas, x: Math.floor(pointer.x) - left, y: Math.floor(pointer.y) - top };
    } finally {
      for (const node of hidden) node.visible(true);
    }
  }

  /** A pointer move while picking: redraw the loupe on the next frame (moves coalesce). */
  private scheduleLoupe(): void {
    if (!this.pick || this.loupeFrame) return;
    this.loupeFrame = requestAnimationFrame(() => {
      this.loupeFrame = 0;
      this.updateLoupe();
    });
  }

  /** Place the loupe at the pointer: the zoomed composite and the hex of the pixel under it. */
  private updateLoupe(): void {
    if (!this.pick) return;
    const at = this.pointer();
    const shot = this.compositeAround();
    if (!at || !shot) {
      this.loupe.visible(false);
      this.guides.batchDraw();
      return;
    }
    const ctx = context2d(this.loupeCanvas);
    const pixel = context2d(shot.canvas).getImageData(shot.x, shot.y, 1, 1).data;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, LOUPE_SIDE, LOUPE_SIDE);
    ctx.drawImage(shot.canvas, 0, 0, LOUPE_CROP, LOUPE_CROP, 0, 0, LOUPE_SIDE, LOUPE_SIDE);
    // A black-then-white box on the pixel under the pointer, readable on any colour.
    const k = LOUPE_SIDE / LOUPE_CROP;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.strokeRect(shot.x * k - 1, shot.y * k - 1, k + 2, k + 2);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.strokeRect(shot.x * k - 0.5, shot.y * k - 0.5, k + 1, k + 1);
    this.loupeText.text(pixel[3] === 0 ? "transparent" : hexOf(pixel[0], pixel[1], pixel[2]));
    this.loupeLabel.position({ x: (LOUPE_SIDE - this.loupeLabel.width()) / 2, y: LOUPE_SIDE });
    // Constant size on screen at any zoom, just below-right of the pointer (as the readout).
    const view = this.view();
    this.loupe.scale({ x: 1 / view.scale, y: 1 / view.scale });
    this.loupe.position({ x: at.x + READOUT_OFFSET / view.scale, y: at.y + READOUT_OFFSET / view.scale });
    this.loupe.visible(true);
    this.guides.batchDraw();
  }

  private beginMiddlePan(e: MouseEvent): void {
    if (e.button !== 1) return;
    e.preventDefault(); // no browser autoscroll
    e.stopPropagation(); // Konva never sees it: no select, no layer drag
    if (!this.interactive) return; // interaction is suspended; every tool pans
    this.middlePan = { view: this.view(), pointer: { x: e.clientX, y: e.clientY } };
  }

  private moveMiddlePan(e: MouseEvent): void {
    const pan = this.middlePan;
    if (!pan) return;
    if ((e.buttons & 4) === 0) {
      this.middlePan = null; // released outside the window
      return;
    }
    this.setHandView(panView(pan.view, pan.pointer, { x: e.clientX, y: e.clientY }));
  }

  /**
   * Zoom one wheel notch around a point given in client (window) px: for
   * wheel events that land on something above the canvas, such as the text
   * overlay, which Konva never sees.
   */
  zoomAtClient(clientX: number, clientY: number, deltaY: number): void {
    const box = this.container.getBoundingClientRect();
    this.setHandView(zoomAround(this.view(), { x: clientX - box.left, y: clientY - box.top }, deltaY));
  }

  private onWheel(e: Konva.KonvaEventObject<WheelEvent>): void {
    e.evt.preventDefault();
    const pointer = this.stage.getPointerPosition();
    if (!pointer) return;
    this.setHandView(zoomAround(this.view(), pointer, e.evt.deltaY));
  }

  /** Bring Konva in line with the model: create, update, order, drop nodes. */
  private render(): void {
    const doc = this.session.doc;
    this.backdrop.size({ width: doc.width, height: doc.height });
    this.outline.size({ width: doc.width, height: doc.height });
    const live = new Set(doc.layers.map((l) => l.id));
    for (const [id, node] of this.nodes) {
      if (!live.has(id)) {
        node.destroy();
        this.nodes.delete(id);
      }
    }
    doc.layers.forEach((layer, index) => {
      const node = this.nodeFor(layer);
      // skew is reset so the view can never hold skew the model lacks
      // (ADR-0005). Text shows its Rust rendering (SPM-9), so the view draws
      // the pixels merge, Crop and the save produce, in the same box. An
      // override (effect preview, warp press) shows instead, never stored;
      // a layer under a refine brush stroke shows the stroke's live canvas.
      const o = this.override?.id === layer.id ? this.override : null;
      const painting = !o && this.stroke?.stroke.layerId === layer.id ? this.stroke.canvas : null;
      const image = o
        ? (o.image instanceof HTMLCanvasElement ? o.image : canvasFor(o.image))
        : painting ?? canvasFor(layerImage(layer));
      node.setAttrs({ ...(o ? o.transform : layer.transform), skewX: 0, skewY: 0, image });
      // Only the Move tool moves layers.
      node.draggable(this.tool === "move");
      node.visible(layer.id !== this.editing);
      // z-order: the backdrop is index 0, layers follow bottom to top.
      node.zIndex(index + 1);
    });
    // No handles in the effect tools: the node shows the preview's grown
    // box, which is not the layer's to resize.
    this.transformer.nodes(
      hasPreview(this.tool) ? [] : this.session.selection.flatMap((id) => {
        const node = this.nodes.get(id);
        return node && id !== this.editing ? [node] : [];
      }),
    );
    this.transformer.moveToTop();
    this.content.batchDraw();
    this.drawRegion();
    // A new canvas size, or a Crop, never moves the view (SPEC §6).
  }

  private nodeFor(layer: Layer): Konva.Image {
    const existing = this.nodes.get(layer.id);
    if (existing) return existing;
    const node = new Konva.Image({ image: canvasFor(layerImage(layer)), draggable: true });
    node.id(layer.id);
    // Press selects (so a drag moves what you grabbed); modifiers toggle.
    node.on("mousedown touchstart", (e) => {
      e.cancelBubble = true;
      const mode = selectModeFor(e.evt as MouseEvent);
      if (mode === "toggle" || !this.session.selection.includes(layer.id)) {
        this.session.select(layer.id, mode);
      }
    });
    node.on("dragend transformend", () => this.queueTransform(layer.id));
    // Double-click a text layer to edit its text. Looked up when it happens:
    // a Crop can turn a text layer into pixels under the same id.
    node.on("dblclick dbltap", () => {
      if (this.session.doc.layers.find((l) => l.id === layer.id)?.kind === "text") this.editText?.(layer.id);
    });
    this.content.add(node);
    this.nodes.set(layer.id, node);
    return node;
  }

  /**
   * Commit moved/transformed nodes as ONE undo step: dragging or resizing
   * several selected layers fires an event per node in the same tick.
   */
  private queueTransform(id: string): void {
    const first = this.pending.size === 0;
    this.pending.add(id);
    if (!first) return;
    queueMicrotask(() => {
      const ids = [...this.pending];
      this.pending.clear();
      // Unchanged transforms (a click without a real drag) add no step:
      // apply() skips an operation that returns the same document.
      this.session.apply((doc: Doc) =>
        ids.reduce((d, layerId) => {
          const node = this.nodes.get(layerId);
          const layer = d.layers.find((l) => l.id === layerId);
          if (!node || !layer) return d;
          const next = transformOf(node);
          return sameTransform(layer.transform, next) ? d : setTransform(d, layerId, next);
        }, doc),
      );
    });
  }
}

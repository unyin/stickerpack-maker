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
import { lassoRegion, rectRegion } from "../model/region";
import type { EditorSession } from "../model/session";
import { fitView, selectModeFor, zoomAround, type ViewTransform } from "./geometry";

/**
 * What dragging on the canvas does: "move" moves the layer under the
 * pointer (or pans on empty space); "rect" and "lasso" draw the cut
 * selection (SPM-9) and never move layers.
 */
export type CanvasTool = "move" | "rect" | "lasso";

/** Lasso points closer than this many screen px to the previous one are skipped. */
const LASSO_STEP = 2;

/** Canvas per pixel buffer: pixels are immutable, so a buffer draws once. */
const canvases = new WeakMap<RgbaImage, HTMLCanvasElement>();

function canvasFor(image: RgbaImage): HTMLCanvasElement {
  const cached = canvases.get(image);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("this webview cannot draw 2D canvases");
  context.putImageData(new ImageData(image.pixels, image.width, image.height), 0, 0);
  canvases.set(image, canvas);
  return canvas;
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
  private readonly nodes = new Map<string, Konva.Image>();
  private readonly pending = new Set<string>();
  private readonly resizeObserver: ResizeObserver;
  /** Watches <html data-theme> (set by src/theme.ts) to recolour the canvas. */
  private readonly themeObserver = new MutationObserver(() => this.applyTheme());
  private readonly unsubscribe: () => void;
  private viewChanged?: (view: ViewTransform) => void;
  private editText?: (id: string) => void;
  private tool: CanvasTool = "move";
  private interactive = true;
  /** The text layer whose overlay editor is open: its node is hidden meanwhile. */
  private editing: string | null = null;
  /** The selection being drawn: its start, and the lasso's points so far (document px). */
  private drawing: { start: Point; points: Point[] } | null = null;
  private readonly endDrawing = () => this.finishRegion();
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
    this.guides.add(this.outline, this.boxHalo, this.box, this.regionHalo, this.regionLine);
    this.content.add(this.backdrop);
    this.content.add(this.transformer);
    this.stage.add(this.content);
    this.stage.add(this.guides);

    this.stage.on("wheel", (e) => this.onWheel(e));
    this.stage.on("dragmove dragend", (e) => {
      if (e.target !== this.stage) return;
      if (e.type === "dragend") this.fitted = true; // a hand pan is never overwritten
      this.viewChanged?.(this.view());
    });
    this.stage.on("click tap", (e) => {
      if (e.target === this.stage && this.tool === "move") this.session.clearSelection();
    });
    this.stage.on("mousedown touchstart", () => this.startRegion());
    this.stage.on("mousemove touchmove", () => this.extendRegion());
    // Released anywhere, even outside the canvas, a drawn selection ends.
    window.addEventListener("mouseup", this.endDrawing);
    window.addEventListener("touchend", this.endDrawing);

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

  /** Choose what dragging on the canvas does (SPM-9). */
  setTool(tool: CanvasTool): void {
    this.tool = tool;
    this.drawing = null;
    this.applyListening();
    this.render();
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

  /** Show or hide the crop box overlay (it is on when the stage opens). */
  setCropBoxVisible(visible: boolean): void {
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
    this.applyListening();
  }

  /** Layers listen and empty space pans only when interactive with the Move tool. */
  private applyListening(): void {
    const moving = this.interactive && this.tool === "move";
    this.content.listening(moving);
    this.stage.draggable(moving);
    this.content.batchDraw();
  }

  destroy(): void {
    window.removeEventListener("mouseup", this.endDrawing);
    window.removeEventListener("touchend", this.endDrawing);
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
    this.content.batchDraw();
    this.guides.batchDraw();
  }

  private setView(view: ViewTransform): void {
    this.stage.scale({ x: view.scale, y: view.scale });
    this.stage.position({ x: view.x, y: view.y });
    this.viewChanged?.(view);
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

  private startRegion(): void {
    if (this.tool === "move" || !this.interactive) return;
    const start = this.pointer();
    if (!start) return;
    this.drawing = { start, points: [start] };
    this.drawRegion();
  }

  private extendRegion(): void {
    const drawing = this.drawing;
    const at = this.pointer();
    if (!drawing || !at) return;
    const last = drawing.points[drawing.points.length - 1];
    const step = LASSO_STEP / this.stage.scaleX();
    if (this.tool === "rect") drawing.points = [drawing.start, at];
    else if (Math.hypot(at.x - last.x, at.y - last.y) >= step) drawing.points.push(at);
    this.drawRegion();
  }

  /** Finish drawing: the session's region becomes the shape (or nothing, for a click). */
  private finishRegion(): void {
    const drawing = this.drawing;
    if (!drawing) return;
    this.drawing = null;
    const { points } = drawing;
    const region =
      this.tool === "rect" ? rectRegion(drawing.start, points[points.length - 1]) : lassoRegion(points);
    if (region === this.session.region) this.drawRegion();
    else this.session.setRegion(region);
  }

  /** Draw the selection being drawn, else the session's region. */
  private drawRegion(): void {
    let points: readonly Point[] = this.session.region?.points ?? [];
    if (this.drawing) {
      const { start, points: drawn } = this.drawing;
      const end = drawn[drawn.length - 1];
      points =
        this.tool === "rect"
          ? [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }]
          : drawn;
    }
    const flat = points.flatMap((p) => [p.x, p.y]);
    for (const line of [this.regionHalo, this.regionLine]) {
      line.points(flat);
      line.visible(points.length > 1);
    }
    this.guides.batchDraw();
  }

  private onWheel(e: Konva.KonvaEventObject<WheelEvent>): void {
    e.evt.preventDefault();
    const pointer = this.stage.getPointerPosition();
    if (!pointer) return;
    this.setView(zoomAround(this.view(), pointer, e.evt.deltaY));
    this.fitted = true; // a hand zoom is never overwritten
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
      // the pixels merge, Crop and the save produce, in the same box.
      node.setAttrs({ ...layer.transform, skewX: 0, skewY: 0, image: canvasFor(layerImage(layer)) });
      node.visible(layer.id !== this.editing);
      // z-order: the backdrop is index 0, layers follow bottom to top.
      node.zIndex(index + 1);
    });
    this.transformer.nodes(
      this.session.selection.flatMap((id) => {
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

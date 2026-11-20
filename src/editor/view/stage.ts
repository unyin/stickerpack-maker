// The Konva view of an editing session (ADR-0005): it draws the model and
// turns gestures into model operations. It never holds state the model
// lacks, so undo/redo and save never read from Konva.
import Konva from "konva";
import type { RgbaImage } from "../api";
import { setTransform, type Doc, type Layer, type Transform } from "../model/document";
import type { EditorSession } from "../model/session";
import { fitView, selectModeFor, zoomAround, type ViewTransform } from "./geometry";

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
function checkerTile(): HTMLCanvasElement {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 16;
  const context = tile.getContext("2d");
  if (context) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 16, 16);
    context.fillStyle = "#e3e6ea";
    context.fillRect(0, 0, 8, 8);
    context.fillRect(8, 8, 8, 8);
  }
  return tile;
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
  private readonly transformer = new Konva.Transformer({
    rotateEnabled: true,
    keepRatio: true,
    ignoreStroke: true,
  });
  private readonly nodes = new Map<string, Konva.Shape>();
  private readonly pending = new Set<string>();
  private readonly resizeObserver: ResizeObserver;
  private readonly unsubscribe: () => void;
  private viewChanged?: (view: ViewTransform) => void;

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
    this.backdrop = new Konva.Rect({
      fillPatternImage: checkerTile() as unknown as HTMLImageElement,
      stroke: "#9aa5b1",
      strokeWidth: 1,
      strokeScaleEnabled: false,
      listening: false,
    });
    this.content.add(this.backdrop);
    this.content.add(this.transformer);
    this.stage.add(this.content);

    this.stage.on("wheel", (e) => this.onWheel(e));
    this.stage.on("dragmove dragend", (e) => {
      if (e.target === this.stage) this.viewChanged?.(this.view());
    });
    this.stage.on("click tap", (e) => {
      if (e.target === this.stage) this.session.clearSelection();
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.unsubscribe = session.subscribe(() => this.render());
    this.render();
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

  /** Fit the whole document in view (never above 100%). */
  fit(): void {
    const doc = this.session.doc;
    this.setView(fitView({ width: this.stage.width(), height: this.stage.height() }, doc, FIT_MARGIN));
  }

  destroy(): void {
    this.unsubscribe();
    this.resizeObserver.disconnect();
    this.stage.destroy();
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
  }

  private onWheel(e: Konva.KonvaEventObject<WheelEvent>): void {
    e.evt.preventDefault();
    const pointer = this.stage.getPointerPosition();
    if (!pointer) return;
    this.setView(zoomAround(this.view(), pointer, e.evt.deltaY));
  }

  /** Bring Konva in line with the model: create, update, order, drop nodes. */
  private render(): void {
    const doc = this.session.doc;
    this.backdrop.size({ width: doc.width, height: doc.height });
    const live = new Set(doc.layers.map((l) => l.id));
    for (const [id, node] of this.nodes) {
      if (!live.has(id)) {
        node.destroy();
        this.nodes.delete(id);
      }
    }
    doc.layers.forEach((layer, index) => {
      const node = this.nodeFor(layer);
      node.setAttrs({ ...layer.transform });
      if (layer.kind === "raster") (node as Konva.Image).image(canvasFor(layer.image));
      else {
        (node as Konva.Text).setAttrs({
          text: layer.text,
          fontFamily: layer.fontFamily,
          fontSize: layer.fontSize,
          fill: layer.color,
        });
      }
      // z-order: the backdrop is index 0, layers follow bottom to top.
      node.zIndex(index + 1);
    });
    this.transformer.nodes(
      this.session.selection.flatMap((id) => {
        const node = this.nodes.get(id);
        return node ? [node] : [];
      }),
    );
    this.transformer.moveToTop();
    this.content.batchDraw();
  }

  private nodeFor(layer: Layer): Konva.Shape {
    const existing = this.nodes.get(layer.id);
    if (existing && (existing instanceof Konva.Image) === (layer.kind === "raster")) return existing;
    existing?.destroy();
    const node: Konva.Shape =
      layer.kind === "raster"
        ? new Konva.Image({ image: canvasFor(layer.image), draggable: true })
        : new Konva.Text({ draggable: true });
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

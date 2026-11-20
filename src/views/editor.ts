// The Editor (SPEC §6, SPM-5 foundation): one session at a time. With no
// session, "Open image" starts one; while open, "Add image as layer" is the
// only way to bring in another image; "Close" ends it (warning on unsaved
// changes). The session survives switching tabs: the view is built once.
import { ask } from "@tauri-apps/plugin-dialog";
import "../editor/editor.css";
import { baseName } from "../api";
import { importImage, mergeImages, pickImageFile, probeImage, type RgbaImage } from "../editor/api";
import {
  addRasterLayer,
  IDENTITY,
  layerIndex,
  mergeLayers,
  moveLayer,
  newDocument,
  type Doc,
} from "../editor/model/document";
import { EditorSession } from "../editor/model/session";
import { centeredPlacement, mergeBlocker, selectModeFor } from "../editor/view/geometry";
import { EditorStage } from "../editor/view/stage";
import { el, errorMessage } from "../ui";

let root: HTMLElement | null = null;

/** The Editor view; built once and reused so the session survives tab switches. */
export function renderEditor(): HTMLElement {
  root ??= buildEditor();
  return root;
}

function buildEditor(): HTMLElement {
  let session: EditorSession | null = null;
  let stage: EditorStage | null = null;
  let busy = false;

  const message = el("p", { class: "message editor-message", role: "alert" });
  const canvasHost = el("div", { class: "editor-canvas" }) as HTMLDivElement;
  const layersList = el("ol", { class: "editor-layers-list" });
  const zoomLabel = el("span", { class: "editor-zoom muted" });
  const dirtyLabel = el("span", { class: "editor-dirty" }, "● Unsaved changes");
  const mergeHint = el("p", { class: "editor-hint muted" });

  const openButton = button("Open image", () => run(openImage), "primary");
  const addButton = button("Add image as layer", () => run(addImageAsLayer), "primary");
  const undoButton = button("Undo", () => session?.undo());
  const redoButton = button("Redo", () => session?.redo());
  const fitButton = button("Fit", () => stage?.fit());
  const closeButton = button("Close", () => run(closeSession));
  const upButton = button("Move up", () => moveSelected(+1));
  const downButton = button("Move down", () => moveSelected(-1));
  const mergeButton = button("Merge selected", () => run(mergeSelected));

  undoButton.title = "Undo (Ctrl+Z)";
  redoButton.title = "Redo (Ctrl+Y)";

  const empty = el(
    "div",
    { class: "editor-empty" },
    el("p", {}, "Open an image to start editing."),
    el("p", { class: "muted" }, "JPG, JPEG, JFIF, PNG or WEBP. Images larger than 2000×2000 can be scaled to fit."),
    openButton,
  );

  const toolbar = el(
    "div",
    { class: "editor-toolbar" },
    addButton,
    undoButton,
    redoButton,
    fitButton,
    zoomLabel,
    dirtyLabel,
    el("span", { class: "editor-spacer" }),
    closeButton,
  );

  const layersPanel = el(
    "aside",
    { class: "editor-layers" },
    el("h2", {}, "Layers"),
    layersList,
    el("div", { class: "editor-layer-actions" }, upButton, downButton, mergeButton),
    mergeHint,
  );

  const workspace = el("div", { class: "editor-workspace" }, canvasHost, layersPanel);
  const view = el("section", { class: "view editor" }, toolbar, message, empty, workspace);

  /** Run an async action with one-at-a-time busy handling and error reporting. */
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    message.textContent = "";
    refresh();
    try {
      await action();
    } catch (err) {
      message.textContent = errorMessage(err);
    } finally {
      busy = false;
      refresh();
    }
  }

  /** Pick an image and decode it, asking first when it exceeds 2000×2000. */
  async function pickAndImport(): Promise<{ image: RgbaImage; name: string } | null> {
    const path = await pickImageFile();
    if (!path) return null;
    const info = await probeImage(path);
    if (info.exceedsCap) {
      const ok = await ask(
        `This image is ${info.width}×${info.height}, larger than 2000×2000.\n\n` +
          "OK scales it to fit within 2000×2000 (longest side 2000, aspect ratio kept). Cancel aborts the import.",
        { title: "Image too large", kind: "warning", okLabel: "OK", cancelLabel: "Cancel" },
      );
      if (!ok) return null;
    }
    return { image: await importImage(path, info.exceedsCap), name: baseName(path) };
  }

  async function openImage(): Promise<void> {
    if (session) return; // one session at a time: Close first
    const picked = await pickAndImport();
    if (!picked) return;
    session = new EditorSession(newDocument(picked.image, picked.name));
    session.subscribe(refresh);
    refresh(); // show the workspace so the stage measures its real size
    stage = new EditorStage(canvasHost, session);
    stage.onViewChange((v) => (zoomLabel.textContent = `${Math.round(v.scale * 100)}%`));
  }

  async function addImageAsLayer(): Promise<void> {
    const current = session;
    if (!current) return;
    const picked = await pickAndImport();
    if (!picked) return;
    const before = current.doc;
    current.apply((doc) => addRasterLayer(doc, picked.image, picked.name, centeredPlacement(doc, picked.image)));
    selectNew(current, before);
  }

  async function mergeSelected(): Promise<void> {
    const current = session;
    if (!current || mergeBlocker(current.doc, current.selection)) return;
    const doc = current.doc;
    // Bottom to top, as they are drawn.
    const chosen = doc.layers.filter((l) => current.selection.includes(l.id));
    const placed = await mergeImages(
      chosen.flatMap((l) => (l.kind === "raster" ? [{ image: l.image, transform: l.transform }] : [])),
    );
    current.apply((d) =>
      mergeLayers(
        d,
        chosen.map((l) => l.id),
        placed.image,
        { ...IDENTITY, x: placed.x, y: placed.y },
      ),
    );
    selectNew(current, doc);
  }

  async function closeSession(): Promise<void> {
    if (!session) return;
    if (session.isDirty) {
      const discard = await ask("Close the editor and discard your unsaved changes?", {
        title: "Unsaved changes",
        kind: "warning",
        okLabel: "Discard",
        cancelLabel: "Keep editing",
      });
      if (!discard) return;
    }
    stage?.destroy();
    stage = null;
    session = null;
  }

  function moveSelected(step: number): void {
    const current = session;
    if (!current || current.selection.length !== 1) return;
    const id = current.selection[0];
    current.apply((doc) => {
      const index = layerIndex(doc, id);
      const target = index + step;
      return target < 0 || target >= doc.layers.length ? doc : moveLayer(doc, id, target);
    });
  }

  /** Select the layer an operation just created (the one id `before` lacked). */
  function selectNew(current: EditorSession, before: Doc): void {
    const old = new Set(before.layers.map((l) => l.id));
    const created = current.doc.layers.find((l) => !old.has(l.id));
    if (created) current.select(created.id);
  }

  function renderLayers(current: EditorSession): void {
    const doc = current.doc;
    layersList.replaceChildren(
      // Top of the stack first, as layer panels read.
      ...[...doc.layers].reverse().map((layer) => {
        const item = el(
          "li",
          { class: current.selection.includes(layer.id) ? "selected" : "" },
          el("span", { class: "editor-layer-kind" }, layer.kind === "raster" ? "Image" : "Text"),
          el("span", { class: "editor-layer-name" }, layer.name),
        );
        item.addEventListener("click", (e) => current.select(layer.id, selectModeFor(e)));
        return item;
      }),
    );
  }

  function refresh(): void {
    const current = session;
    empty.hidden = current !== null;
    workspace.hidden = current === null;
    toolbar.hidden = current === null;
    openButton.disabled = busy;
    if (!current) {
      layersList.replaceChildren();
      return;
    }
    renderLayers(current);
    const doc = current.doc;
    const single = current.selection.length === 1 ? current.selection[0] : null;
    const index = single ? layerIndex(doc, single) : -1;
    const blocker = mergeBlocker(doc, current.selection);
    addButton.disabled = busy;
    closeButton.disabled = busy;
    undoButton.disabled = busy || !current.canUndo;
    redoButton.disabled = busy || !current.canRedo;
    upButton.disabled = busy || !single || index === doc.layers.length - 1;
    downButton.disabled = busy || !single || index === 0;
    mergeButton.disabled = busy || blocker !== null;
    mergeButton.title = blocker ?? "Merge the selected layers into one";
    mergeHint.textContent = current.selection.length > 0 ? (blocker ?? "") : "";
    dirtyLabel.hidden = !current.isDirty;
  }

  // Shortcuts while the Editor is on screen and no text field has focus.
  document.addEventListener("keydown", (e) => {
    const current = session;
    if (!current || !view.isConnected || busy) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) current.undo();
    else if ((e.ctrlKey || e.metaKey) && (key === "y" || (key === "z" && e.shiftKey))) current.redo();
    else if (e.key === "Escape") current.clearSelection();
    else return;
    e.preventDefault();
  });

  refresh();
  return view;
}

function button(label: string, onClick: () => void, variant?: "primary"): HTMLButtonElement {
  const b = el("button", { class: variant ?? "secondary" }, label) as HTMLButtonElement;
  b.addEventListener("click", onClick);
  return b;
}

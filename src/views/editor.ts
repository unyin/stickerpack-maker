// The Editor (SPEC §6, SPM-5 foundation): one session at a time. With no
// session, "Open image" starts one; while open, "Add image as layer" is the
// only way to bring in another image; "Close" ends it (warning on unsaved
// changes). The session survives switching tabs: the view is built once.
import { ask } from "@tauri-apps/plugin-dialog";
import "../editor/editor.css";
import { baseName } from "../api";
import { cropImages, IMPORT_MAX_SIDE, importImage, mergeImages, pickImageFile, probeImage } from "../editor/api";
import {
  addRasterLayer,
  centeredPlacement,
  cropBox,
  cropClipInputs,
  cropLayers,
  deleteLayers,
  fitToBox,
  IDENTITY,
  layerIndex,
  resizeLongestSide,
  resizeSideProblem,
  mergeLayers,
  moveLayer,
  newDocument,
  nextLayerId,
  planCrop,
  scaleLongestSide,
  type CropAction,
  type Doc,
  type Rect,
} from "../editor/model/document";
import type { RgbaImage } from "../editor/model/image";
import { readoutStatus, STICKER, startCanvas } from "../editor/model/constraints";
import { EditorSession } from "../editor/model/session";
import {
  cropBlocker,
  deleteBlocker,
  mergeBlocker,
  selectModeFor,
  sizeToolBlocker,
  type SizeTool,
} from "../editor/view/geometry";
import { EditorStage } from "../editor/view/stage";
import { confirmChoice } from "../dialog";
import { el, errorMessage, withMessage } from "../ui";

let root: HTMLElement | null = null;

/** The Editor view; built once and reused so the session survives tab switches. */
export function renderEditor(): HTMLElement {
  root ??= buildEditor();
  return root;
}

function buildEditor(): HTMLElement {
  // The active constraint set (SPEC §6-7). Sticker mode is the only one wired
  // in the UI; Thumbnail mode (SPM-12) passes THUMBNAIL instead.
  const constraints = STICKER;
  const targetSide = constraints.side;
  let session: EditorSession | null = null;
  let stage: EditorStage | null = null;
  let busy = false;
  // The crop box overlay is on by default (owner, 2026-11-20).
  let showBox = true;

  const message = el("p", { class: "message editor-message", role: "alert" });
  const canvasHost = el("div", { class: "editor-canvas" }) as HTMLDivElement;
  const layersList = el("ol", { class: "editor-layers-list" });
  const zoomLabel = el("span", { class: "editor-zoom muted" });
  const dirtyLabel = el("span", { class: "editor-dirty" }, "● Unsaved changes");
  const layerHint = el("p", { class: "editor-hint muted" });
  // Live readout of the canvas against the constraint set (SPEC §6).
  const readout = el("span", { class: "editor-readout", "aria-live": "polite" });

  const openButton = button("Open image", () => run(openImage), "primary");
  const addButton = button("Add image as layer", () => run(addImageAsLayer), "primary");
  const undoButton = button("Undo", () => session?.undo());
  const redoButton = button("Redo", () => session?.redo());
  // Sizing tools (SPEC §6), all on the whole image as one group.
  const fitButton = button(`Fit to ${targetSide}×${targetSide}`, () =>
    resizeWholeImage((doc, c) => fitToBox(doc, c, targetSide)),
  );
  const longestButton = button(`Longest side ${targetSide}`, () =>
    resizeWholeImage((doc, c) => scaleLongestSide(doc, c, targetSide)),
  );
  const sideInput = el("input", {
    class: "editor-side-input",
    type: "number",
    min: "1",
    max: String(IMPORT_MAX_SIDE),
    step: "1",
    placeholder: "px",
    "aria-label": "Longest side in pixels",
  }) as HTMLInputElement;
  const resizeButton = button("Resize", () => freeResize());
  const boxButton = button("Crop box", () => toggleBox());
  // Labelled with the actual box size in refresh(): it is capped at the canvas.
  const cropButton = button("Crop", () => run(cropToBox));
  const resetViewButton = button("Reset view", () => stage?.fit());
  const closeButton = button("Close", () => run(async () => void (await closeSession())));
  const upButton = button("Move up", () => moveSelected(+1));
  const downButton = button("Move down", () => moveSelected(-1));
  const mergeButton = button("Merge selected", () => run(mergeSelected));
  const deleteButton = button("Delete", () => deleteSelected());

  undoButton.title = "Undo (Ctrl+Z)";
  redoButton.title = "Redo (Ctrl+Y)";
  const fitTitle =
    `Scale everything on the canvas together, as one image, so its longest side is ${targetSide} px; ` +
    `the canvas becomes ${targetSide}×${targetSide} with transparent padding`;
  const longestTitle =
    `Scale everything on the canvas together so its longest side is ${targetSide} px; the canvas becomes the image (no padding)`;
  const resizeTitle =
    `Scale everything on the canvas together so its longest side is the entered size (1–${IMPORT_MAX_SIDE} px); ` +
    "the canvas size stays";
  fitButton.title = fitTitle;
  longestButton.title = longestTitle;
  resizeButton.title = resizeTitle;
  resetViewButton.title = "Zoom and centre the canvas in view (changes the view only)";
  boxButton.title = "Show or hide the crop box";
  const cropTitle = (size: string) =>
    `Discard everything outside the ${size} box; drag the image to choose what stays. The canvas size stays`;
  sideInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") freeResize();
  });
  sideInput.addEventListener("input", () => refresh());

  const empty = el(
    "div",
    { class: "editor-empty" },
    el("p", {}, "Open an image to start editing."),
    el("p", { class: "muted" }, `JPG, JPEG, JFIF, PNG or WEBP. Images larger than ${IMPORT_MAX_SIDE}×${IMPORT_MAX_SIDE} can be scaled to fit.`),
    openButton,
  );

  const toolbar = el(
    "div",
    { class: "editor-toolbar" },
    addButton,
    undoButton,
    redoButton,
    el(
      "span",
      { class: "editor-tool-group", role: "group", "aria-label": "Size" },
      el("span", { class: "muted" }, "Size:"),
      fitButton,
      longestButton,
      el("label", { class: "editor-side" }, "Longest side ", sideInput, " px"),
      resizeButton,
    ),
    el(
      "span",
      { class: "editor-tool-group", role: "group", "aria-label": "Crop" },
      boxButton,
      cropButton,
    ),
    readout,
    resetViewButton,
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
    el("div", { class: "editor-layer-actions" }, upButton, downButton, mergeButton, deleteButton),
    layerHint,
  );

  const workspace = el("div", { class: "editor-workspace" }, canvasHost, layersPanel);
  const view = el("section", { class: "view editor" }, toolbar, message, empty, workspace);

  /** Run an async action with one-at-a-time busy handling and error reporting. */
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    stage?.setInteractive(false); // nothing is edited while an action works
    refresh();
    try {
      await withMessage(message, action);
    } finally {
      busy = false;
      stage?.setInteractive(true);
      refresh();
    }
  }

  /** Pick an image and decode it, asking first when it exceeds the import cap. */
  async function pickAndImport(given?: string): Promise<{ image: RgbaImage; name: string } | null> {
    const path = given ?? (await pickImageFile());
    if (!path) return null;
    const info = await probeImage(path);
    if (info.exceedsCap) {
      const side = `${IMPORT_MAX_SIDE}×${IMPORT_MAX_SIDE}`;
      const ok = await ask(
        `This image is ${info.width}×${info.height}, larger than ${side}.\n\n` +
          `OK scales it to fit within ${side} (longest side ${IMPORT_MAX_SIDE}, aspect ratio kept). Cancel aborts the import.`,
        { title: "Image too large", kind: "warning", okLabel: "OK", cancelLabel: "Cancel" },
      );
      if (!ok) return null;
    }
    return { image: await importImage(path, info.exceedsCap), name: baseName(path) };
  }

  async function openImage(path?: string): Promise<void> {
    if (session) return; // one session at a time: Close first
    const picked = await pickAndImport(path);
    if (!picked) return;
    session = new EditorSession(newDocument(picked.image, picked.name, startCanvas(constraints)));
    refresh(); // show the workspace so the stage measures its real size
    stage = new EditorStage(canvasHost, session);
    stage.setCropGuidesVisible(showBox);
    refresh(); // place the crop box overlay
    // Subscribe AFTER the stage: on every change the canvas redraws first,
    // so refresh() measures current content (Fit's enabled state).
    session.subscribe(refresh);
    stage.onViewChange((v) => (zoomLabel.textContent = `${Math.round(v.scale * 100)}%`));
  }

  async function addImageAsLayer(): Promise<void> {
    const current = session;
    if (!current) return;
    const picked = await pickAndImport();
    if (!picked) return;
    const id = nextLayerId(current.doc);
    current.apply((doc) => addRasterLayer(doc, picked.image, picked.name, centeredPlacement(doc, picked.image)));
    current.select(id);
  }

  async function mergeSelected(): Promise<void> {
    const current = session;
    if (!current || mergeBlocker(current.doc, current.selection)) return;
    const doc = current.doc;
    // Bottom to top, as they are drawn.
    const chosen = doc.layers.filter((l) => current.selection.includes(l.id));
    const id = nextLayerId(doc);
    const placed = await mergeImages(
      chosen.flatMap((l) => (l.kind === "raster" ? [{ image: l.image, transform: l.transform }] : [])),
    );
    if (current.doc !== doc) {
      message.textContent = "The layers changed while merging; nothing was merged. Try again.";
      return;
    }
    current.apply((d) =>
      mergeLayers(
        d,
        chosen.map((l) => l.id),
        placed.image,
        { ...IDENTITY, x: placed.x, y: placed.y },
      ),
    );
    current.select(id);
  }

  /**
   * Crop (SPEC §6): discard every layer's content outside the box as ONE
   * undo step. Layers crossing the box edge are re-rendered in Rust; layers
   * entirely outside it are removed. The canvas size and the view stay.
   */
  async function cropToBox(): Promise<void> {
    const current = session;
    if (!current) return;
    const doc = current.doc;
    const { plan, blocker } = cropState(doc);
    if (blocker) return;
    const clips = cropClipInputs(doc, plan);
    const images = clips.length > 0 ? await cropImages(clips) : [];
    if (current.doc !== doc) {
      message.textContent = "The layers changed while cropping; nothing was cropped. Try again.";
      return;
    }
    current.apply((d) => cropLayers(d, plan, new Map(clips.map((c, i) => [c.id, images[i]]))));
  }

  /**
   * The crop box, Crop's plan and its blocker for a document: the ONE place
   * they are computed. refresh() feeds the overlay, the label and the
   * button from it, and Crop runs from it, so all four use the same box.
   */
  function cropState(doc: Doc): { box: Rect; plan: CropAction[]; blocker: string | null } {
    const box = cropBox(doc, targetSide);
    const plan = planCrop(doc, box);
    return { box, plan, blocker: cropBlocker(plan, box) };
  }

  function toggleBox(): void {
    showBox = !showBox;
    stage?.setCropGuidesVisible(showBox);
    refresh();
  }

  /**
   * End the session, asking first when it has unsaved changes (Close, and
   * opening another image from the Pack Manager). Resolves false when the
   * user keeps editing, so the session stays.
   */
  async function closeSession(): Promise<boolean> {
    if (!session) return true;
    if (session.isDirty && !(await confirmDiscard())) return false;
    stage?.destroy();
    stage = null;
    session = null;
    return true;
  }

  /**
   * Apply a sizing tool (SPEC §6) to the whole image: everything on the
   * canvas as one group, measured like a multi-layer selection. One undo step.
   */
  function resizeWholeImage(tool: (doc: Doc, content: Rect) => Doc): void {
    const current = session;
    if (!current || !stage || busy) return;
    const content = stage.contentBounds();
    message.textContent = "";
    try {
      current.apply((doc) => tool(doc, content));
    } catch (err) {
      message.textContent = errorMessage(err);
    }
  }

  /** The free-resize field as a number; NaN when empty (so the shared rule rejects it). */
  function enteredSide(): number {
    return sideInput.value.trim() === "" ? NaN : Number(sideInput.value);
  }

  /** Sizing tool 3 (SPEC §6): free resize, the entered value is the longest side; the canvas stays. */
  function freeResize(): void {
    const side = enteredSide();
    const problem = resizeSideProblem(side);
    if (problem) {
      message.textContent = problem;
      return;
    }
    resizeWholeImage((doc, content) => resizeLongestSide(doc, content, side));
  }

  /** Delete the selected layers as one undoable step (SPEC §6); one layer always stays. */
  function deleteSelected(): void {
    const current = session;
    if (!current || busy || deleteBlocker(current.doc, current.selection)) return;
    const chosen = [...current.selection];
    current.apply((doc) => deleteLayers(doc, chosen));
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
    const deleteReason = deleteBlocker(doc, current.selection);
    addButton.disabled = busy;
    // Each sizing tool is disabled when it would change nothing or, for Longest
    // side, when the set needs a square canvas (SPEC §6).
    const content = stage ? stage.contentBounds() : null;
    const entered = enteredSide();
    const sizing: [HTMLButtonElement, SizeTool, string][] = [
      [fitButton, "fit", fitTitle],
      [longestButton, "longest", longestTitle],
      [resizeButton, "free", resizeTitle],
    ];
    for (const [button, tool, action] of sizing) {
      const reason = sizeToolBlocker(tool, doc, content, entered, constraints);
      button.disabled = busy || reason !== null;
      button.title = reason ?? action;
    }
    sideInput.disabled = busy;
    // One cropState result drives the overlay, the label and the blocker;
    // cropToBox() reads the same function.
    const { box, blocker: cropReason } = cropState(doc);
    stage?.setCropBox(box);
    const boxSize = `${box.width}×${box.height}`;
    cropButton.textContent = `Crop to ${boxSize}`;
    cropButton.disabled = busy || cropReason !== null;
    cropButton.title = cropReason ?? cropTitle(boxSize);
    boxButton.setAttribute("aria-pressed", String(showBox));
    const status = readoutStatus(doc, constraints);
    readout.textContent = status.text;
    readout.classList.toggle("off", !status.ok);
    resetViewButton.disabled = busy;
    closeButton.disabled = busy;
    undoButton.disabled = busy || !current.canUndo;
    redoButton.disabled = busy || !current.canRedo;
    upButton.disabled = busy || !single || index === doc.layers.length - 1;
    downButton.disabled = busy || !single || index === 0;
    mergeButton.disabled = busy || blocker !== null;
    mergeButton.title = blocker ?? "Merge the selected layers into one";
    deleteButton.disabled = busy || deleteReason !== null;
    deleteButton.title = deleteReason ?? "Delete the selected layers (Delete key)";
    // Explain disabled actions only once something is selected.
    layerHint.textContent =
      current.selection.length > 0 ? [blocker, deleteReason].filter((r) => r !== null).join(" ") : "";
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
    else if (e.key === "Delete") deleteSelected();
    else return;
    e.preventDefault();
  });

  // Pack Manager hook (SPM-3), see openFileInEditor below.
  openFileHook = (path, showEditor) =>
    run(async () => {
      const closed = await closeSession(); // warns on unsaved changes
      showEditor(); // either way: Keep editing shows the open image
      if (closed) await openImage(path);
    });

  refresh();
  return view;
}

let openFileHook: ((path: string, showEditor: () => void) => Promise<void>) | null = null;

/**
 * Open the image at `path` in the Editor, as Open image would (import cap
 * dialog included): the Pack Manager's Edit and "open in editor" (SPM-3).
 * One session at a time. In order (owner decision 2026-11-21): an open
 * session with unsaved changes asks first, while the caller's view is still
 * showing; then `showEditor` switches to the Editor either way (the canvas
 * must be on screen to measure itself); then, unless the user kept editing,
 * the file opens.
 */
export function openFileInEditor(path: string, showEditor: () => void): Promise<void> {
  renderEditor(); // builds the Editor once, which installs the hook
  return openFileHook ? openFileHook(path, showEditor) : Promise.resolve();
}

/** The unsaved-changes question, worded for both Close and opening another image. */
function confirmDiscard(): Promise<boolean> {
  return confirmChoice(
    "Unsaved changes",
    [el("p", {}, "The editor has unsaved changes. Do you want to discard these or continue editing?")],
    { actionLabel: "Discard", keepLabel: "Keep editing", danger: true },
  );
}

function button(label: string, onClick: () => void, variant?: "primary"): HTMLButtonElement {
  return el("button", { class: variant ?? "secondary", onclick: onClick }, label) as HTMLButtonElement;
}

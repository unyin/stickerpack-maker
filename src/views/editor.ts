// The Editor (SPEC §6, SPM-5 foundation): one session at a time. With no
// session, "Open image" starts one; while open, "Add image as layer" and
// pasting (Ctrl+V) bring in other images; "Close" ends it (warning on unsaved
// changes). The session survives switching tabs: the view is built once.
// SPM-9 adds the text tool, the cut selection tools and paste.
import { ask } from "@tauri-apps/plugin-dialog";
import "../editor/editor.css";
import { baseName } from "../api";
import {
  cropImages,
  cutImage,
  IMPORT_MAX_SIDE,
  importImage,
  importPasted,
  listFonts,
  mergeImages,
  pickImageFile,
  probeImage,
  probePasted,
  renderText,
  type ImageInfo,
} from "../editor/api";
import {
  addRasterLayer,
  addTextLayer,
  centeredPlacement,
  cropBox,
  cropClipInputs,
  cropLayers,
  cutLayer,
  deleteLayers,
  fitToBox,
  IDENTITY,
  layerInput,
  layerIndex,
  resizeLongestSide,
  resizeSideProblem,
  mergeLayers,
  moveLayer,
  newDocument,
  nextLayerId,
  planCrop,
  scaleLongestSide,
  restyledTexts,
  setTextStyles,
  textStyleOf,
  type CropAction,
  type Doc,
  type Rect,
  type TextStyle,
} from "../editor/model/document";
import type { RgbaImage } from "../editor/model/image";
import { readoutStatus, STICKER, startCanvas, TEXT_FONT_SIZE } from "../editor/model/constraints";
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_TEXT_COLOR,
  defaultFontFamily,
  fontSizeProblem,
  isBlankText,
  isHexColor,
  nextStyleAfter,
  type NextStyle,
} from "../editor/model/text";
import { EditorSession } from "../editor/model/session";
import {
  cropBlocker,
  cutBlocker,
  deleteBlocker,
  editTextBlocker,
  escapeTarget,
  fontChoices,
  layerHint as layerHintText,
  mergeBlocker,
  selectModeFor,
  sizeToolBlocker,
  textBlocker,
  textOverlayPlacement,
  type SizeTool,
} from "../editor/view/geometry";
import { EditorStage, type CanvasTool } from "../editor/view/stage";
import { TextEditOverlay } from "../editor/view/text-edit";
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
  // What dragging on the canvas does: move layers, or draw the cut selection.
  let tool: CanvasTool = "move";
  // The installed font families, loaded once (null while loading), and why
  // there are none. Never changed after loading.
  let fonts: readonly string[] | null = null;
  let fontsProblem: string | null = null;
  // The families the font select currently lists (see fontChoices).
  let listedFonts: readonly string[] = [];
  // The style the next new text gets: the text controls edit it while no
  // text layer is selected.
  let nextStyle: NextStyle = { fontFamily: "", fontSize: DEFAULT_FONT_SIZE, color: DEFAULT_TEXT_COLOR };

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
  const closeButton = button("Close", () => run(closeSession));
  const upButton = button("Move up", () => moveSelected(+1));
  const downButton = button("Move down", () => moveSelected(-1));
  const mergeButton = button("Merge selected", () => run(mergeSelected));
  const deleteButton = button("Delete", () => deleteSelected());
  // Cut selection tools and paste (SPM-9).
  const moveToolButton = button("Move", () => setTool("move"));
  const rectToolButton = button("Rectangle", () => setTool("rect"));
  const lassoToolButton = button("Lasso", () => setTool("lasso"));
  const cutButton = button("Cut", () => run(cutSelection));
  const pasteButton = button("Paste", () => run(pasteFromButton));
  moveToolButton.title = "Drag layers to move them, or empty space to pan";
  rectToolButton.title = "Drag on the canvas to select a rectangle to cut";
  lassoToolButton.title = "Drag on the canvas to draw a freehand selection to cut";
  const cutTitle = "Move the selected pixels into a new floating layer at the same spot";
  const pasteTitle = "Paste an image from the clipboard as a new layer (Ctrl+V)";
  // Text tool (SPM-9): the controls style the selected text layers, or the next new text.
  const textButton = button("Add text", () => editText(null));
  const editTextButton = button("Edit text", () => {
    const id = session?.selection[0];
    if (id) editText(id);
  });
  const fontSelect = el("select", { class: "editor-font-select", "aria-label": "Font" }) as HTMLSelectElement;
  const fontSizeInput = el("input", {
    class: "editor-side-input",
    type: "number",
    min: String(TEXT_FONT_SIZE.min),
    max: String(TEXT_FONT_SIZE.max),
    step: "1",
    "aria-label": "Font size in pixels",
  }) as HTMLInputElement;
  const colorInput = el("input", { class: "editor-color-input", type: "color", "aria-label": "Text colour" }) as HTMLInputElement;
  // After a committed change the control gives up focus, so the editor's
  // shortcuts (Ctrl+Z, Delete, Esc, Ctrl+V) work at once. Typing in the size
  // input is not hijacked: it commits only on Enter or when focus leaves.
  fontSelect.addEventListener("change", () => {
    restyle({ fontFamily: fontSelect.value });
    fontSelect.blur();
  });
  fontSizeInput.addEventListener("change", () => {
    const size = Number(fontSizeInput.value);
    const problem = fontSizeProblem(size);
    if (problem) {
      message.textContent = problem;
      refresh(); // shows the current size again
      return;
    }
    restyle({ fontSize: size });
    fontSizeInput.blur();
  });
  colorInput.addEventListener("change", () => {
    if (isHexColor(colorInput.value)) restyle({ color: colorInput.value.toLowerCase() });
    colorInput.blur();
  });
  const textTitle = "Type a new text layer in the chosen font, size and colour (Enter to finish, Shift+Enter for a new line)";
  const editTextTitle = "Edit the selected text layer's text (or double-click it)";

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
    el(
      "span",
      { class: "editor-tool-group", role: "group", "aria-label": "Select and cut" },
      moveToolButton,
      rectToolButton,
      lassoToolButton,
      cutButton,
      pasteButton,
    ),
    el(
      "span",
      { class: "editor-tool-group", role: "group", "aria-label": "Text" },
      textButton,
      editTextButton,
      fontSelect,
      el("label", { class: "editor-side" }, fontSizeInput, " px"),
      colorInput,
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
  const textOverlay = new TextEditOverlay(canvasHost);
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

  /**
   * The async edit pattern: snapshot the document, await Rust on it, and if
   * the document is still that snapshot commit the result, else refuse with
   * a message (a result computed from a stale document must not be applied).
   * `work` resolving null means there is nothing to apply (e.g. cancelled).
   * `onStale` is either the refusal wording, completing "The layers changed
   * while {doing}; nothing was {done}." (results computed from the snapshot:
   * merge, crop, cut, restyle), or "ignore" for work that never reads it
   * (paste, new text), which commits against the current document.
   */
  async function editAsync<T>(
    current: EditorSession,
    onStale: { doing: string; done: string } | "ignore",
    work: (doc: Doc) => Promise<T | null>,
    commit: (result: T, doc: Doc) => void,
  ): Promise<void> {
    const doc = current.doc;
    const result = await work(doc);
    if (result === null) return;
    if (onStale === "ignore") {
      commit(result, current.doc);
      return;
    }
    if (current.doc !== doc) {
      message.textContent = `The layers changed while ${onStale.doing}; nothing was ${onStale.done}. Try again.`;
      return;
    }
    commit(result, doc);
  }

  /**
   * Decode an image with the import cap rule (SPEC §6): an image over the
   * cap needs the OK in the scale-to-fit dialog; Cancel aborts (null).
   */
  async function importWithCap(
    info: ImageInfo,
    decode: (scaleToFit: boolean) => Promise<RgbaImage>,
  ): Promise<RgbaImage | null> {
    if (info.exceedsCap) {
      const side = `${IMPORT_MAX_SIDE}×${IMPORT_MAX_SIDE}`;
      const ok = await ask(
        `This image is ${info.width}×${info.height}, larger than ${side}.\n\n` +
          `OK scales it to fit within ${side} (longest side ${IMPORT_MAX_SIDE}, aspect ratio kept). Cancel aborts the import.`,
        { title: "Image too large", kind: "warning", okLabel: "OK", cancelLabel: "Cancel" },
      );
      if (!ok) return null;
    }
    return decode(info.exceedsCap);
  }

  /** Pick an image and decode it, asking first when it exceeds the import cap. */
  async function pickAndImport(): Promise<{ image: RgbaImage; name: string } | null> {
    const path = await pickImageFile();
    if (!path) return null;
    const image = await importWithCap(await probeImage(path), (scale) => importImage(path, scale));
    return image ? { image, name: baseName(path) } : null;
  }

  async function openImage(): Promise<void> {
    if (session) return; // one session at a time: Close first
    const picked = await pickAndImport();
    if (!picked) return;
    session = new EditorSession(newDocument(picked.image, picked.name, startCanvas(constraints)));
    refresh(); // show the workspace so the stage measures its real size
    stage = new EditorStage(canvasHost, session);
    stage.setCropBoxVisible(showBox);
    stage.setTool(tool);
    stage.onEditText((id) => editText(id));
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
    if (!current || mergeBlocker(current.selection)) return;
    await editAsync(
      current,
      { doing: "merging", done: "merged" },
      async (doc) => {
        // Bottom to top, as they are drawn; text goes as text and Rust rasterises it (SPM-9).
        const chosen = doc.layers.filter((l) => current.selection.includes(l.id));
        return { chosen, placed: await mergeImages(chosen.map(layerInput)) };
      },
      ({ chosen, placed }, doc) => {
        const id = nextLayerId(doc);
        current.apply((d) =>
          mergeLayers(
            d,
            chosen.map((l) => l.id),
            placed.image,
            { ...IDENTITY, x: placed.x, y: placed.y },
          ),
        );
        current.select(id);
      },
    );
  }

  /**
   * Crop (SPEC §6): discard every layer's content outside the box as ONE
   * undo step. Layers crossing the box edge are re-rendered in Rust; layers
   * entirely outside it are removed. The canvas size and the view stay.
   */
  async function cropToBox(): Promise<void> {
    const current = session;
    if (!current || cropState(current.doc).blocker) return;
    await editAsync(
      current,
      { doing: "cropping", done: "cropped" },
      async (doc) => {
        // Text crossing the box edge is rasterised and clipped like an image (SPM-9).
        const plan = cropState(doc).plan;
        const clips = cropClipInputs(doc, plan);
        const images = clips.length > 0 ? await cropImages(clips) : [];
        return { plan, byId: new Map(clips.map((c, i) => [c.id, images[i]])) };
      },
      ({ plan, byId }) => current.apply((d) => cropLayers(d, plan, byId)),
    );
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
    stage?.setCropBoxVisible(showBox);
    refresh();
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
    textOverlay.close();
    stage?.destroy();
    stage = null;
    session = null;
    tool = "move";
  }

  // ---- Cut and paste (SPM-9) ----

  function setTool(next: CanvasTool): void {
    tool = next;
    stage?.setTool(next);
    refresh();
  }

  /**
   * Cut (SPM-9): the selected pixels of the selected image layer move into
   * a new floating layer at the same spot, as ONE undo step; the pixel work
   * is Rust's. The selection is used up, and the Move tool comes back so the
   * cutout can be dragged and resized at once.
   */
  async function cutSelection(): Promise<void> {
    const current = session;
    if (!current || cutBlocker(current.doc, current.selection, current.region)) return;
    const region = current.region!;
    await editAsync(
      current,
      { doing: "cutting", done: "cut" },
      async (doc) => {
        const source = doc.layers[layerIndex(doc, current.selection[0])];
        return source.kind === "raster" ? { source, cut: await cutImage(source.image, source.transform, region.points) } : null;
      },
      ({ source, cut }, doc) => {
        const id = nextLayerId(doc);
        current.apply((d) => cutLayer(d, source.id, cut));
        current.setRegion(null);
        current.select(id);
        setTool("move");
      },
    );
  }

  /** Add a pasted image (encoded bytes) as a new layer, centred, under the import cap rule. */
  async function pasteImage(bytes: Uint8Array): Promise<void> {
    const current = session;
    if (!current) return;
    await editAsync(
      current,
      "ignore",
      () => probePasted(bytes).then((info) => importWithCap(info, (scale) => importPasted(bytes, scale))),
      (image, doc) => {
        const id = nextLayerId(doc);
        current.apply((d) => addRasterLayer(d, image, "Pasted image", centeredPlacement(d, image)));
        current.select(id);
      },
    );
  }

  /** The Paste button: read an image from the clipboard where the webview allows it. */
  async function pasteFromButton(): Promise<void> {
    let blob: Blob | null = null;
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          blob = await item.getType(type);
          break;
        }
      }
    } catch {
      message.textContent = "The clipboard can't be read here: press Ctrl+V to paste an image.";
      return;
    }
    if (!blob) {
      message.textContent = "The clipboard holds no image.";
      return;
    }
    await pasteImage(new Uint8Array(await blob.arrayBuffer()));
  }

  // ---- Text (SPM-9) ----

  /**
   * Open the text overlay: for a new text layer (`id` null) centred on the
   * canvas in the chosen style, or over an existing text layer to edit it.
   * Committing renders the text in Rust and applies ONE undo step; blank
   * text creates or changes nothing (decision: delete a text layer with
   * Delete instead).
   */
  function editText(id: string | null): void {
    const current = session;
    if (!current || !stage || busy || textBlocker(fonts, fontsProblem)) return;
    const layer = id === null ? null : current.doc.layers.find((l) => l.id === id);
    if (layer && layer.kind !== "text") return;
    const style: TextStyle = layer ? textStyleOf(layer) : { ...nextStyle, text: "" };
    setTool("move");
    if (layer) {
      current.select(layer.id);
      stage.setEditing(layer.id);
    }
    const placement = textOverlayPlacement(stage.view(), layer ?? null, current.doc);
    textOverlay.open(
      { ...style, lineHeight: layer ? layer.render.metrics.lineHeight : null, placement },
      {
        commit: (text) => {
          stage?.setEditing(null);
          if (isBlankText(text) || text === style.text) return;
          void run(() => (layer ? restyleLayers([layer.id], { text }) : addText({ ...style, text })));
        },
        cancel: () => stage?.setEditing(null),
      },
    );
  }

  async function addText(style: TextStyle): Promise<void> {
    const current = session;
    if (!current) return;
    await editAsync(
      current,
      "ignore",
      () => renderText(style),
      (render, doc) => {
        const id = nextLayerId(doc);
        current.apply((d) => addTextLayer(d, style, render, centeredPlacement(d, render.image)));
        current.select(id);
      },
    );
  }

  /** Re-render text layers with a style change, as ONE undo step. */
  async function restyleLayers(ids: readonly string[], patch: Partial<TextStyle>): Promise<void> {
    const current = session;
    if (!current) return;
    await editAsync(
      current,
      { doing: "drawing the text", done: "changed" },
      async (doc) => {
        const styles = restyledTexts(doc, ids, patch);
        const renders = await Promise.all(styles.map((c) => renderText(c.style)));
        return styles.map((c, i) => ({ ...c, render: renders[i] }));
      },
      (changes) => current.apply((d) => setTextStyles(d, changes)),
    );
  }

  /**
   * A text control changed (SPEC §6): restyle the selected text layers, or,
   * when none is selected, set the style of the next new text.
   */
  function restyle(patch: Partial<NextStyle>): void {
    const ids = session ? session.selectedTexts.map((l) => l.id) : [];
    nextStyle = nextStyleAfter(nextStyle, ids.length, patch);
    if (ids.length > 0) void run(() => restyleLayers(ids, patch));
    else refresh();
  }

  /** Load the installed fonts once (Rust scans them); the text tool waits for them. */
  async function loadFonts(): Promise<void> {
    try {
      const families = await listFonts();
      const first = defaultFontFamily(families);
      if (first === null) fontsProblem = "No fonts were found on this computer.";
      else {
        fonts = families;
        nextStyle = { ...nextStyle, fontFamily: first };
      }
    } catch (err) {
      fontsProblem = `The installed fonts could not be listed: ${errorMessage(err)}`;
    }
    refresh();
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
    const blocker = mergeBlocker(current.selection);
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
    // Cut selection tools and paste (SPM-9).
    for (const [b, t] of [
      [moveToolButton, "move"],
      [rectToolButton, "rect"],
      [lassoToolButton, "lasso"],
    ] as const) {
      b.setAttribute("aria-pressed", String(tool === t));
      b.disabled = busy;
    }
    const cutReason = cutBlocker(doc, current.selection, current.region);
    cutButton.disabled = busy || cutReason !== null;
    cutButton.title = cutReason ?? cutTitle;
    pasteButton.disabled = busy;
    pasteButton.title = pasteTitle;
    // Text tool (SPM-9): the controls show the first selected text layer's
    // style, else the next new text's.
    const texts = current.selectedTexts;
    const shown = texts.length > 0 ? textStyleOf(texts[0]) : nextStyle;
    const textReason = textBlocker(fonts, fontsProblem);
    textButton.disabled = busy || textReason !== null;
    textButton.title = textReason ?? textTitle;
    const editReason = editTextBlocker(textReason, doc, current.selection);
    editTextButton.disabled = busy || editReason !== null;
    editTextButton.title = editReason ?? editTextTitle;
    // The select lists the installed fonts, plus a layer's font that is no longer installed.
    const choices = fontChoices(fonts ?? [], shown.fontFamily);
    if (choices.length !== listedFonts.length || choices.some((f, i) => f !== listedFonts[i])) {
      fontSelect.replaceChildren(...choices.map((f) => el("option", { value: f }, f)));
      listedFonts = choices;
    }
    fontSelect.value = shown.fontFamily;
    if (document.activeElement !== fontSizeInput) fontSizeInput.value = String(shown.fontSize);
    colorInput.value = shown.color;
    for (const control of [fontSelect, fontSizeInput, colorInput]) control.disabled = busy || textReason !== null;
    const target = texts.length > 0 ? "the selected text" : "the next text";
    fontSelect.title = textReason ?? `Font of ${target}`;
    fontSizeInput.title = textReason ?? `Font size of ${target} in px (${TEXT_FONT_SIZE.min}–${TEXT_FONT_SIZE.max})`;
    colorInput.title = textReason ?? `Colour of ${target}`;
    // Explain disabled actions only once something is selected.
    layerHint.textContent = layerHintText(doc, current.selection, current.region, {
      merge: blocker,
      delete: deleteReason,
      cut: cutReason,
      editText: editReason,
    });
    dirtyLabel.hidden = !current.isDirty;
  }

  /**
   * True when keys and paste belong to a form control or the text overlay,
   * never to the layers: text fields, the font list, editable content.
   */
  function isTextTarget(target: EventTarget | null): boolean {
    const t = target as HTMLElement | null;
    return !!t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable);
  }

  // Shortcuts while the Editor is on screen and no text field has focus.
  // While text is typed in the overlay (a TEXTAREA), Delete, undo/redo and
  // Esc act on the text (SPM-9).
  document.addEventListener("keydown", (e) => {
    const current = session;
    if (!current || !view.isConnected || busy || textOverlay.isOpen) return;
    if (isTextTarget(e.target)) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) current.undo();
    else if ((e.ctrlKey || e.metaKey) && (key === "y" || (key === "z" && e.shiftKey))) current.redo();
    // Esc drops the cut selection first, then the layer selection.
    else if (e.key === "Escape") escapeTarget(current.region) === "region" ? current.setRegion(null) : current.clearSelection();
    else if (e.key === "Delete") deleteSelected();
    else return;
    e.preventDefault();
  });

  // Ctrl+V with an image on the clipboard adds it as a layer (SPM-9).
  document.addEventListener("paste", (e) => {
    if (!session || !view.isConnected || busy || textOverlay.isOpen || isTextTarget(e.target)) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
    const file = item?.getAsFile();
    e.preventDefault();
    if (!file) {
      message.textContent = "The clipboard holds no image to paste.";
      return;
    }
    void run(async () => pasteImage(new Uint8Array(await file.arrayBuffer())));
  });

  void loadFonts();
  refresh();
  return view;
}

function button(label: string, onClick: () => void, variant?: "primary"): HTMLButtonElement {
  return el("button", { class: variant ?? "secondary", onclick: onClick }, label) as HTMLButtonElement;
}

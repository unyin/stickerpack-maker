// The Editor (SPEC §6, SPM-5 foundation): one session at a time. With no
// session, "Open image" starts one; while open, "Add image as layer" and
// pasting (Ctrl+V) bring in other images; "Close" ends it (warning on unsaved
// changes). The session survives switching tabs: the view is built once.
// SPM-9 adds the text tool, the cut selection tools and paste.
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
  saveImage,
  type ImageInfo,
} from "../editor/api";
import {
  declinedText,
  EXHAUSTED_TITLE,
  exhaustedText,
  pngTooLargeText,
  runSave,
  saveBlocker,
  savedText,
  type SaveFormat,
  originAfterSave,
  type SaveTarget,
  type TooLarge,
} from "../editor/save";
import type { StickerOrigin } from "../shared/sticker-origin";
import { saveDialog } from "../editor/view/save-dialog";
import { packMemory } from "../pack-manager/model/pack-memory";
import { markStickerFileChanged } from "../pack-manager/model/changed-files";
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
  cropTextNotice,
  cutBlocker,
  deleteBlocker,
  editTextBlocker,
  escapeTarget,
  isCutShortcut,
  fontChoices,
  layerHint as layerHintText,
  mergeBlocker,
  selectModeFor,
  sizeToolBlocker,
  textBlocker,
  textOverlayPlacement,
  type SizeTool,
  type ViewTransform,
} from "../editor/view/geometry";
import { EditorStage, type CanvasTool } from "../editor/view/stage";
import { TextEditOverlay } from "../editor/view/text-edit";
import { FontPicker } from "../editor/view/font-picker";
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
  // What the left button does on the canvas: move layers, or draw the cut selection.
  let tool: CanvasTool = "move";
  // The text layer the open overlay edits (null: new text), to keep it placed as the view moves.
  let overlayLayerId: string | null = null;
  // The installed font families, loaded once (null while loading), and why
  // there are none. Never changed after loading.
  let fonts: readonly string[] | null = null;
  let fontsProblem: string | null = null;
  // The style the next new text gets: the text controls edit it while no
  // text layer is selected.
  let nextStyle: NextStyle = { fontFamily: "", fontSize: DEFAULT_FONT_SIZE, color: DEFAULT_TEXT_COLOR };
  // The save dialog starts on the last save's format (SPM-10); its pack comes from packMemory.
  let lastFormat: SaveFormat = "png";
  // The sticker this session edits when the Pack Manager's Edit opened it, else null (SPM-10).
  let origin: StickerOrigin | null = null;

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
  const undoButton = button("Undo", () => {
    clearNote();
    session?.undo();
  });
  const redoButton = button("Redo", () => {
    clearNote();
    session?.redo();
  });
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
  const saveButton = button("Save…", () => run(saveSession), "primary");
  const saveTitle = "Save the canvas as a sticker in a pack (Ctrl+S)";
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
  lassoToolButton.title =
    "Click to place points, drag to draw freehand; click the start point, double-click or press Enter to close (Backspace removes the last point or stroke, Esc cancels)";
  const cutTitle = "Move the selected pixels into a new floating layer at the same spot";
  const pasteTitle = "Paste an image from the clipboard as a new layer (Ctrl+V)";
  // Text tool (SPM-9): the controls style the selected text layers, or the next new text.
  const textButton = button("Add text", () => editText(null));
  const editTextButton = button("Edit text", () => {
    const id = session?.selection[0];
    if (id) editText(id);
  });
  // Font names shown in their own typeface, with type-to-search (owner, 2026-11-22).
  const fontPicker = new FontPicker("Font");
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
  fontPicker.onChange((fontFamily) => restyle({ fontFamily })); // the picker gives up focus itself
  fontSizeInput.addEventListener("change", () => {
    const size = Number(fontSizeInput.value);
    const problem = fontSizeProblem(size);
    if (problem) {
      say(problem);
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
      fontPicker.element,
      el("label", { class: "editor-side" }, fontSizeInput, " px"),
      colorInput,
    ),
    readout,
    resetViewButton,
    zoomLabel,
    dirtyLabel,
    el("span", { class: "editor-spacer" }),
    // Save and Close stay together when the toolbar wraps.
    el("span", { class: "editor-session-actions" }, saveButton, closeButton),
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
  // The wheel over the typing overlay zooms the canvas like anywhere else (owner re-test 2026-11-22).
  const textOverlay = new TextEditOverlay(canvasHost, (e) => stage?.zoomAtClient(e.clientX, e.clientY, e.deltaY));
  const view = el("section", { class: "view editor" }, toolbar, message, empty, workspace);

  /**
   * Show a line in the message area: an error or blocked-action reason in
   * red, or a neutral note (`"note"`, e.g. after Crop converted text).
   * `run()` clears the line (and its tone) with `say("")` before an action,
   * so errors that `withMessage` writes directly always show in the error tone.
   */
  function say(text: string, tone: "error" | "note" = "error"): void {
    message.textContent = text;
    message.classList.toggle("is-note", tone === "note");
  }

  /** Undo and redo take the neutral note back with them (owner decision 2026-11-22); errors stay. */
  function clearNote(): void {
    if (message.classList.contains("is-note")) say("");
  }

  /** Run an async action with one-at-a-time busy handling and error reporting. */
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    stage?.setInteractive(false); // nothing is edited while an action works
    say(""); // a note never carries over into the action's error
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
      say(`The layers changed while ${onStale.doing}; nothing was ${onStale.done}. Try again.`);
      return;
    }
    commit(result, doc);
  }

  /**
   * Decode an image with the import cap rule (SPEC §6): an image over the
   * cap needs "Scale to fit" in the shared dialog; Cancel aborts (null).
   */
  async function importWithCap(
    info: ImageInfo,
    decode: (scaleToFit: boolean) => Promise<RgbaImage>,
  ): Promise<RgbaImage | null> {
    if (info.exceedsCap && !(await confirmScaleToFit(info))) return null;
    return decode(info.exceedsCap);
  }

  /** Pick an image and decode it, asking first when it exceeds the import cap. */
  async function pickAndImport(given?: string): Promise<{ image: RgbaImage; name: string } | null> {
    const path = given ?? (await pickImageFile());
    if (!path) return null;
    const image = await importWithCap(await probeImage(path), (scale) => importImage(path, scale));
    return image ? { image, name: baseName(path) } : null;
  }

  async function openImage(path?: string, from: StickerOrigin | null = null): Promise<void> {
    if (session) return; // one session at a time: Close first
    const picked = await pickAndImport(path);
    if (!picked) return;
    origin = from;
    session = new EditorSession(newDocument(picked.image, picked.name, startCanvas(constraints)));
    refresh(); // show the workspace so the stage measures its real size
    stage = new EditorStage(canvasHost, session);
    stage.setCropGuidesVisible(showBox);
    stage.setTool(tool);
    stage.onEditText((id) => editText(id));
    refresh(); // place the crop box overlay
    // Subscribe AFTER the stage: on every change the canvas redraws first,
    // so refresh() measures current content (Fit's enabled state).
    session.subscribe(refresh);
    stage.onViewChange((v) => {
      zoomLabel.textContent = `${Math.round(v.scale * 100)}%`;
      placeTextOverlay(v); // typing overlay follows pan and zoom
    });
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
      ({ plan, byId }, doc) => {
        current.apply((d) => cropLayers(d, plan, byId));
        const notice = cropTextNotice(doc, plan);
        if (notice) say(notice, "note");
      },
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
    endSession();
    return true;
  }

  /** End the session at once, unsaved changes included (the caller has asked). */
  function endSession(): void {
    origin = null;
    textOverlay.close();
    stage?.destroy();
    stage = null;
    session = null;
    tool = "move";
  }

  // ---- Save (SPM-10) ----

  /**
   * Save (SPEC §6, hard-blocked): the save dialog picks the pack and the
   * format; Rust flattens what is inside the canvas, encodes it within the
   * size cap and appends it to the pack. A PNG over the cap offers WEBP; a
   * WEBP over the cap even at its lowest quality sends the user back to the
   * Editor (owner decision 2026-11-21, CMT-144). A save clears the unsaved
   * changes; the session stays open.
   */
  async function saveSession(): Promise<void> {
    const current = session;
    if (!current || saveBlocker(current.doc, constraints)) return;
    const doc = current.doc;
    let exhausted: TooLarge | null = null;
    await saveDialog({
      constraints,
      format: lastFormat,
      origin,
      submit: async (choice, setFormat) => {
        const { format } = choice;
        const target: SaveTarget =
          choice.kind === "replace"
            ? { kind: "replace", stickerId: choice.origin.stickerId }
            : { kind: "append", packId: choice.pack.id };
        const packTitle = choice.kind === "replace" ? choice.now.packTitle : choice.pack.title;
        const result = await runSave(format, {
          save: (f) => saveImage(doc, f, target),
          offerWebp: async (outcome) => {
            const ok = await confirmWebp(pngTooLargeText(outcome));
            if (ok) setFormat("webp");
            return ok;
          },
        });
        if (result.kind === "declined") return declinedText(result.outcome);
        if (result.kind === "exhausted") {
          exhausted = result.outcome;
          return null; // the save dialog closes; the question below follows
        }
        const saved = result.outcome;
        packMemory.lastSavedPackId = saved.sticker.packId;
        lastFormat = saved.sticker.format;
        // The open pack view must not keep showing the old picture of a replaced sticker.
        if (target.kind === "replace") markStickerFileChanged(saved.sticker.id);
        // The session now edits the saved sticker: the next save replaces it (design decision 2026-11-22).
        origin = originAfterSave(saved, packTitle);
        // The session cannot change while the dialog is open; check anyway.
        if (current.doc === doc) current.markSaved();
        say(savedText(saved, packTitle, target), "note");
        return null;
      },
    });
    // Even WEBP at its lowest quality is too large (owner decision 2026-11-22):
    // back to the Editor, or give up on this session without the unsaved-changes question.
    // Its limit is the cap Rust held the save to: the constraint set's (or the debug override's).
    // (`submit` sets `exhausted` in a callback, which TypeScript's narrowing cannot see.)
    const tooLarge = exhausted as TooLarge | null;
    if (tooLarge && (await confirmGiveUp(exhaustedText(tooLarge.maxKilobytes))) && session === current) {
      endSession();
    }
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
      say("The clipboard can't be read here: press Ctrl+V to paste an image.");
      return;
    }
    if (!blob) {
      say("No image data on the clipboard. Copied an image file? Press Ctrl+V.");
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
    overlayLayerId = layer ? layer.id : null;
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

  /** Keep the open text overlay over its layer (or the canvas centre, for new text) in view `v`. */
  function placeTextOverlay(v: ViewTransform): void {
    if (!session || !textOverlay.isOpen) return;
    const layer = session.doc.layers.find((l) => l.id === overlayLayerId);
    textOverlay.place(textOverlayPlacement(v, layer?.kind === "text" ? layer : null, session.doc));
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
   * A text control changed (SPEC §6): restyle the selected text layers, if
   * any, and keep the change for the next new text either way.
   */
  function restyle(patch: Partial<NextStyle>): void {
    const ids = session ? session.selectedTexts.map((l) => l.id) : [];
    nextStyle = nextStyleAfter(nextStyle, patch);
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
    say("");
    try {
      current.apply((doc) => tool(doc, content));
    } catch (err) {
      say(errorMessage(err));
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
      say(problem);
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
    const saveReason = saveBlocker(doc, constraints);
    saveButton.disabled = busy || saveReason !== null;
    saveButton.title = saveReason ?? saveTitle;
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
    // The picker lists the installed fonts, plus a layer's font that is no longer installed.
    const choices = fontChoices(fonts ?? [], shown.fontFamily);
    fontPicker.setFonts(choices);
    fontPicker.value = shown.fontFamily;
    if (document.activeElement !== fontSizeInput) fontSizeInput.value = String(shown.fontSize);
    colorInput.value = shown.color;
    for (const control of [fontPicker, fontSizeInput, colorInput]) control.disabled = busy || textReason !== null;
    const target = texts.length > 0 ? "the selected text" : "the next text";
    fontPicker.title = textReason ?? `Font of ${target}`;
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
   * never to the layers: text fields, the font picker's field, editable content.
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
    // Ctrl+S never reaches the webview's own "save page", even while busy.
    if (view.isConnected && isSaveShortcut(e)) e.preventDefault();
    if (!current || !view.isConnected || busy || textOverlay.isOpen) return;
    if (isTextTarget(e.target)) return;
    // A lasso in progress takes Enter, Esc and Backspace first (SPM-9).
    if (stage?.handleLassoKey(e.key)) {
      e.preventDefault();
      return;
    }
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) {
      clearNote();
      current.undo();
    }
    else if ((e.ctrlKey || e.metaKey) && (key === "y" || (key === "z" && e.shiftKey))) {
      clearNote();
      current.redo();
    }
    // Ctrl+S saves; a blocked save says why (SPEC §6: hard-blocked).
    else if (isSaveShortcut(e)) {
      const reason = saveBlocker(current.doc, constraints);
      if (reason) say(reason);
      else void run(saveSession);
    }
    // Ctrl+X is the Cut tool, not the clipboard; a blocked cut says why.
    else if (isCutShortcut(e)) {
      const reason = cutBlocker(current.doc, current.selection, current.region);
      if (reason) say(reason);
      else void run(cutSelection);
    }
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
      say("The clipboard holds no image to paste.");
      return;
    }
    void run(async () => pasteImage(new Uint8Array(await file.arrayBuffer())));
  });

  void loadFonts();

  // Pack Manager hook (SPM-3), see openFileInEditor below.
  openFileHook = (path, showEditor, from) =>
    run(async () => {
      const closed = await closeSession(); // warns on unsaved changes
      showEditor(); // either way: Keep editing shows the open image
      if (closed) await openImage(path, from ?? null);
    });
  // The dialog then says why Replace is gone, rather than silently dropping it.
  forgetOriginHook = () => {
    if (origin) origin = { ...origin, otherLibrary: true };
  };

  refresh();
  return view;
}

let openFileHook: ((path: string, showEditor: () => void, origin?: StickerOrigin) => Promise<void>) | null = null;
let forgetOriginHook: (() => void) | null = null;

/**
 * The Library changed: a session opened with Edit no longer replaces its
 * sticker, whose id belongs to the old Library; its save dialog says so and
 * it can still save as a new sticker.
 */
export function forgetEditorOrigin(): void {
  forgetOriginHook?.();
}

/**
 * Open the image at `path` in the Editor, as Open image would (import cap
 * dialog included): the Pack Manager's Edit and "open in editor" (SPM-3).
 * One session at a time. In order (owner decision 2026-11-21): an open
 * session with unsaved changes asks first, while the caller's view is still
 * showing; then `showEditor` switches to the Editor either way (the canvas
 * must be on screen to measure itself); then, unless the user kept editing,
 * the file opens. `origin` is the sticker it is (Edit): saving then offers
 * to replace it (owner decision 2026-11-22).
 */
export function openFileInEditor(path: string, showEditor: () => void, origin?: StickerOrigin): Promise<void> {
  renderEditor(); // builds the Editor once, which installs the hook
  return openFileHook ? openFileHook(path, showEditor, origin) : Promise.resolve();
}

/** The unsaved-changes question, worded for both Close and opening another image. */
function confirmDiscard(): Promise<boolean> {
  return confirmChoice(
    "Unsaved changes",
    [el("p", {}, "The editor has unsaved changes. Do you want to discard these or continue editing?")],
    { actionLabel: "Discard", keepLabel: "Keep editing", danger: true },
  );
}

/**
 * Even WEBP is too large (owner decision 2026-11-22, the owner's copy):
 * "Maybe I can fix it", the default, returns to the Editor; "Nah fuck it"
 * closes the Editor at once, unsaved changes and all. Resolves true for that.
 */
function confirmGiveUp(text: string): Promise<boolean> {
  return confirmChoice(EXHAUSTED_TITLE, [el("p", {}, text)], {
    actionLabel: "Nah fuck it",
    keepLabel: "Maybe I can fix it",
    danger: true,
  });
}

/** Ctrl+S (Cmd+S): Save. */
function isSaveShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s";
}

/** A PNG over the size cap (owner decision 2026-11-21): offer WEBP; Cancel, the safe choice, keeps the dialog. */
function confirmWebp(body: readonly string[]): Promise<boolean> {
  return confirmChoice("Too large as PNG", body.map((line) => el("p", {}, line)), {
    actionLabel: "Save as WEBP",
    keepLabel: "Cancel",
  });
}

/** The import cap question (SPEC §6); Cancel, the safe choice, aborts the import. */
function confirmScaleToFit(info: ImageInfo): Promise<boolean> {
  const side = `${IMPORT_MAX_SIDE}×${IMPORT_MAX_SIDE}`;
  return confirmChoice(
    "Image too large",
    [
      el("p", {}, `This image is ${info.width}×${info.height}, larger than ${side}.`),
      el(
        "p",
        {},
        `Scale it to fit within ${side}? The longest side becomes ${IMPORT_MAX_SIDE} and the aspect ratio is kept.`,
      ),
    ],
    { actionLabel: "Scale to fit", keepLabel: "Cancel" },
  );
}

function button(label: string, onClick: () => void, variant?: "primary"): HTMLButtonElement {
  return el("button", { class: variant ?? "secondary", onclick: onClick }, label) as HTMLButtonElement;
}

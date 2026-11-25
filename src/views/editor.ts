// The Editor (SPEC §6, SPM-5 foundation): one session at a time. With no
// session, "Open image" starts one; while open, "Add image as layer" and
// pasting (Ctrl+V) bring in other images; "Close" ends it (warning on unsaved
// changes). The session survives switching tabs: the view is built once.
// SPM-9 adds the text tool, the cut selection tools and paste; SPM-8 the
// effect tools (outline, fuzzy glow, warp/bulge); SPM-7 the background
// removal and its Erase/Restore refine brushes; SPM-10 the save pipeline
// (Save…, Ctrl+S); SPM-12 the Thumbnail mode sessions the Pack Manager's
// thumbnail slot opens; SPM-22 the magic-wand selection; SPM-23 the selection
// composing across the three selection tools.
import "../editor/editor.css";
import { baseName } from "../api";
import {
  applyEffect,
  backgroundModelStatus,
  cancelBackgroundDownload,
  composeSelection,
  cropImages,
  cutImage,
  downloadBackgroundModel,
  eraseMask,
  eraseRegion,
  IMPORT_MAX_SIDE,
  importImage,
  importPasted,
  liftMask,
  listFonts,
  mergeImages,
  pickImageFile,
  probeImage,
  probePasted,
  removeImageBackground,
  renderText,
  saveImage,
  wandSelect,
  type DownloadProgress,
  type ImageInfo,
} from "../editor/api";
import { backgroundTarget, refineLayerPixels } from "../editor/model/background";
import { SessionEmoji, type EmojiStore } from "../editor/model/emoji";
import {
  moveWandGesture,
  NOTHING_TO_SELECT_OUTSIDE,
  NOTHING_TO_SELECT_TRANSPARENT,
  refillStepOf,
  startWandGesture,
  TOLERANCE,
  toleranceProblem,
  traceOutlines,
  wandReadout,
  type WandGesture,
  type WandMask,
  type WandMode,
} from "../editor/model/wand";
import { downloadProgressText, megabytes } from "../editor/view/download-text";
import { BRUSH_SIZE, brushSizeProblem } from "../editor/model/brush";
import {
  declinedText,
  EXHAUSTED_TITLE,
  exhaustedText,
  originGoneCloseWarning,
  pngTooLargeText,
  runSave,
  saveBlocker,
  saveRefusal,
  savedText,
  showStickerLink,
  showThumbnailLink,
  stickerGoneText,
  thumbnailGoneText,
  thumbnailSavedText,
  type SaveFormat,
  originAfterSave,
  type Saved,
  type SavedThumbnail,
  type SaveOutcome,
  type SaveTarget,
  type TooLarge,
} from "../editor/save";
import type { StickerOrigin } from "../shared/sticker-origin";
import type { ThumbnailOrigin } from "../shared/thumbnail-origin";
import { originNow, saveDialog, thumbnailSaveDialog } from "../editor/view/save-dialog";
import { packMemory } from "../pack-manager/model/pack-memory";
import { markStickerFileChanged, markThumbnailChanged } from "../pack-manager/model/changed-files";
import { loadPackView, setEmojiString, type Sticker } from "../pack-manager/api";
import {
  anchoredTransform,
  addRasterLayer,
  addTextLayer,
  centeredPlacement,
  cropBox,
  cropClipInputs,
  cropLayers,
  cutLayer,
  deleteLayers,
  docToLocal,
  fillToBox,
  fitToBox,
  IDENTITY,
  layerInput,
  layerIndex,
  resizeSideProblem,
  resizeToSide,
  mergeLayers,
  moveLayer,
  newDocument,
  nextLayerId,
  planCrop,
  scaleLongestSide,
  restyledTexts,
  setLayerImage,
  setTextStyle,
  setTextStyles,
  textStyleOf,
  type CropAction,
  type CutResult,
  type Doc,
  type OutlineStyle,
  type Point,
  type RasterLayer,
  type Rect,
  type ResizeSide,
  type TextLayer,
  type TextRender,
  type TextStyle,
  type Transform,
} from "../editor/model/document";
import type { RgbaImage } from "../editor/model/image";
import {
  contributionsOf,
  NOTHING_TO_CUT,
  NOTHING_TO_ERASE,
  wandCommitMode,
  type ComposedRegion,
  type Contribution,
  type ContributionOp,
  type PolyContribution,
  type Region,
  type WandContribution,
} from "../editor/model/region";
import { readoutStatus, startCanvas, STICKER, THUMBNAIL, TEXT_FONT_SIZE, TEXT_OUTLINE_WIDTH, type ConstraintSet } from "../editor/model/constraints";
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_OUTLINE_COLOR,
  DEFAULT_TEXT_COLOR,
  defaultFontFamily,
  fontSizeProblem,
  isBlankText,
  isHexColor,
  nextStyleAfter,
  outlineWidthProblem,
  type NextStyle,
} from "../editor/model/text";
import { EditorSession } from "../editor/model/session";
import { applyEffectResult, effectBasis, effectKindOf, escDiscardsEffect, nextEffectBasis, effectTarget, effectTextNotice, outlineTextPatch, warpTarget, type EffectBasis, type EffectResult } from "../editor/model/effects";
import {
  cropBlocker,
  cropTextNotice,
  cutBlocker,
  deleteBlocker,
  editTextBlocker,
  eraseBlocker,
  escapeTarget,
  isCutShortcut,
  fontChoices,
  layerHint as layerHintText,
  mergeBlocker,
  selectedLayerSize,
  selectModeFor,
  sizeToolBlocker,
  textBlocker,
  textOverlayPlacement,
  type SizeTool,
  type ViewTransform,
} from "../editor/view/geometry";
import { EditorStage } from "../editor/view/stage";
import type { CanvasTool } from "../editor/model/tools";
import { TextEditOverlay } from "../editor/view/text-edit";
import { FontPicker } from "../editor/view/font-picker";
import { EffectControls } from "../editor/view/effect-controls";
import { shortcutLabel, shortcutOf, type ShortcutAction } from "../editor/model/shortcuts";
import { actionList, renderActionList } from "../editor/view/actions-list";
import { EYEDROPPER_TITLE, eyedropperButton } from "../editor/view/eyedropper";
import { EffectPreview, type PreviewRequest } from "../editor/view/effect-preview";
import { WarpPress } from "../editor/view/warp-brush";
import { moveWarpGesture, startWarpGesture, warpReadout, type WarpGesture } from "../editor/model/warp";
import { confirmChoice } from "../dialog";
import { el, errorMessage, withMessage } from "../ui";

/** The left tools panel's categories (SPEC §6 Layout): one visible at a time. */
type ToolsPanelTab = "select" | "paint" | "effects" | "text";

/**
 * The category a tool surfaces when it is activated — its button, its
 * shortcut, or an automatic return to Move (SPEC §6 Layout, owner decision
 * 2026-11-25). The reverse direction does not exist: a tab click shows its
 * category and never changes the tool.
 */
const TOOL_PANEL: Record<CanvasTool, ToolsPanelTab> = {
  move: "select",
  rect: "select",
  lasso: "select",
  wand: "select",
  erase: "paint",
  restore: "paint",
  warp: "paint",
  outline: "effects",
  glow: "effects",
};

let root: HTMLElement | null = null;

/** The Editor view; built once and reused so the session survives tab switches. */
export function renderEditor(): HTMLElement {
  root ??= buildEditor();
  return root;
}

function buildEditor(): HTMLElement {
  // The active constraint set (SPEC §6-7): Sticker mode for a sticker
  // session, Thumbnail mode (SPM-12) for a pack's thumbnail session. It is
  // session state: never changed mid-session, only on open and close.
  let constraints: ConstraintSet = STICKER;
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
  // text layer is selected. A new text starts with no outline (SPM-18).
  let nextStyle: NextStyle = { fontFamily: "", fontSize: DEFAULT_FONT_SIZE, color: DEFAULT_TEXT_COLOR, outline: null };
  // The save dialog starts on the last save's format (SPM-10); its pack comes from packMemory.
  let lastFormat: SaveFormat = "png";
  // Which side of the whole image the free-resize field sets (CMT-152):
  // interface state like lastFormat, kept across sessions.
  let freeSide: ResizeSide = "longest";
  // The sticker this session edits when the Pack Manager's Edit opened it, else null (SPM-10).
  let origin: StickerOrigin | null = null;
  // The pack whose thumbnail a Thumbnail mode session saves into (SPM-12), else null.
  let thumbnailOrigin: ThumbnailOrigin | null = null;
  // Counts Library changes, so a saved note's link knows its sticker is from an old one.
  let libraryGeneration = 0;
  // The session's Emoji String (SPEC §6 Layout, Emoji tab; SPM-15): staged for
  // a fresh image, written through when the session edits an origin sticker.
  // The tab's box (slice D3) reads and commits through it.
  let emoji: SessionEmoji | null = null;
  // The Rust side of that box: the pack view's sticker and the Pack Manager's
  // own emoji command (set_emoji_string — reuse, not a second command).
  const emojiStore: EmojiStore = {
    read: async (packId, stickerId) => {
      const view = await loadPackView(packId);
      const sticker = view.stickers.find((s) => s.id === stickerId);
      if (!sticker) throw new Error(`sticker ${stickerId} is not in its pack`);
      return sticker.emojiString;
    },
    write: async (stickerId, emojiString) => (await setEmojiString(stickerId, emojiString)).emojiString,
  };

  const message = el("p", { class: "message editor-message", role: "alert" });
  const canvasHost = el("div", { class: "editor-canvas" }) as HTMLDivElement;
  const layersList = el("ol", { class: "editor-layers-list" });
  const zoomLabel = el("span", { class: "editor-zoom muted" });
  const dirtyLabel = el("span", { class: "editor-dirty" }, "● Unsaved changes");
  const layerHint = el("p", { class: "editor-hint muted" });
  // Live readout of the canvas against the constraint set (SPEC §6).
  const readout = el("span", { class: "editor-readout", "aria-live": "polite" });

  const openButton = button("Open image", () => run(openImage), "primary");
  // The ellipsis marks the image picker dialog it opens (SPEC §6 Layout, D3).
  const addButton = button("Add image as layer…", () => run(addImageAsLayer), "primary");
  addButton.title = "Add image as layer… — Pick an image and place it on top of the canvas at its native pixel size";
  const undoButton = button("Undo", () => {
    clearNote();
    session?.undoSelectionFirst();
  });
  const redoButton = button("Redo", () => {
    clearNote();
    session?.redoSelectionFirst();
  });
  // Sizing tools (SPEC §6), all on the whole image as one group. Their labels
  // and titles come from the active constraint set and are (re)set in
  // refresh(), which every session start runs.
  const fitButton = button("Fit", () =>
    resizeWholeImage(`Fit in ${constraints.side}`, (doc, c) => fitToBox(doc, c, constraints.side)),
  );
  // Sizing tool 4 (SPEC §6): Cover is to Fit what CSS cover is to contain.
  const fillButton = button("Cover", () =>
    resizeWholeImage(`Cover ${constraints.side}`, (doc, c) => fillToBox(doc, c, constraints.side)),
  );
  const longestButton = button("Long side", () =>
    resizeWholeImage(`Long side ${constraints.side}`, (doc, c) => scaleLongestSide(doc, c, constraints.side)),
  );
  // The free-resize side-kind choice (CMT-152). It reads as one sentence with
  // the static "side"/"px" text and the field (SPEC §6, owner 2026-11-25):
  // "[Long/Short] side [N] px Resize".
  const sideKind = el("select", { class: "editor-side-kind", "aria-label": "Which side the entered size is" }) as HTMLSelectElement;
  sideKind.append(
    el("option", { value: "longest" }, "Long"),
    el("option", { value: "shortest" }, "Short"),
  );
  sideKind.addEventListener("change", () => {
    freeSide = sideKind.value as ResizeSide;
    refresh();
  });
  const sideInput = el("input", {
    class: "editor-side-input",
    type: "number",
    min: "1",
    max: String(IMPORT_MAX_SIDE),
    step: "1",
    placeholder: "px",
    // The label is set in refresh(), from the side-kind choice.
  }) as HTMLInputElement;
  const resizeButton = button("Resize", () => freeResize());
  const boxButton = button("Guide", () => toggleBox());
  // Labelled with the actual box size in refresh(): it is capped at the canvas.
  const cropButton = button("Crop", () => run(cropToBox));
  const resetViewButton = button("Reset view", () => stage?.fit());
  // Close ends the session, so it carries the app's danger treatment (SPEC §6).
  const closeButton = button("Close", () => run(async () => void (await closeSession())), "danger");
  const saveButton = button("Save…", () => run(saveSession), "primary");
  const saveStem = "Save… (Ctrl+S)";
  /**
   * A control's title under the §2 contract: the name stem always stays and a
   * blocker reason replaces the description; `idle` (the enabled title) shows
   * when there is none.
   */
  const blockedTitle = (name: string, reason: string | null, idle: string): string =>
    reason !== null ? `${name} — ${reason}` : idle;
  /** The Save button's idle title: what saving does in the session's mode. */
  const saveTitle = () =>
    constraints.mode === "thumbnail"
      ? `${saveStem} — Save the canvas as this pack's thumbnail`
      : `${saveStem} — Save the canvas as a sticker in a pack`;
  const upButton = button("Move up", () => moveSelected(+1));
  const downButton = button("Move down", () => moveSelected(-1));
  const mergeButton = button("Merge selected", () => run(mergeSelected));
  const deleteButton = button("Delete", () => deletePressed());
  // Cut selection tools and paste (SPM-9).
  const moveToolButton = button("Move", () => setTool("move"));
  const rectToolButton = button("Rectangle", () => setTool("rect"));
  const lassoToolButton = button("Lasso", () => setTool("lasso"));
  const wandToolButton = button("Wand", () => setTool("wand"));
  const cutButton = button("Cut", () => run(cutSelection));
  const pasteButton = button("Paste", () => run(pasteFromButton));
  // Tooltips follow the §2 contract: Name (Shortcut) — one-line description
  // (SPEC §6 Layout). The single-key tool shortcuts are the table's own.
  const toolTitle = (name: string, action: ShortcutAction, description: string): string => {
    const key = shortcutLabel(action);
    return key ? `${name} (${key}) — ${description}` : `${name} — ${description}`;
  };
  moveToolButton.title = toolTitle("Move", "move", "Drag layers to move them, or empty space to pan");
  rectToolButton.title = toolTitle("Rectangle", "rect", "Drag on the canvas to select a rectangle to cut");
  lassoToolButton.title = toolTitle(
    "Lasso",
    "lasso",
    "Click to place points, drag to draw freehand; click the start point, double-click or press Enter to close (Backspace removes the last point or stroke, Esc cancels)",
  );
  wandToolButton.title = toolTitle(
    "Wand",
    "wand",
    "Click to select the colour-similar pixels of the selected image layer (or the base image); drag to set the tolerance; Shift adds a region, Alt removes one",
  );
  const cutTitle = "Cut (Ctrl+X) — Move the selected pixels into a new floating layer at the same spot";
  // Effect tools (SPM-8): each targets the selected layer, else the base image.
  const outlineToolButton = button("Outline", () => setTool("outline"));
  const glowToolButton = button("Glow", () => setTool("glow"));
  const warpToolButton = button("Warp", () => setTool("warp"));
  outlineToolButton.title = toolTitle("Outline", "outline", "Outline the selected layer (or the base image): preview, then Apply");
  glowToolButton.title = toolTitle("Glow", "glow", "Give the selected layer (or the base image) a fuzzy glow: preview, then Apply");
  warpToolButton.title = toolTitle("Warp", "warp", "Enlarge parts of the selected layer (or the base image) with a bulge brush");

  const effectControls = new EffectControls({
    change: () => refresh(),
    pick: (apply) => stage?.beginColorPick(apply),
    apply: () => void run(applyEffectTool),
    cancel: () => setTool("move"),
  });
  // The live outline/glow preview, drawn by Rust with Apply's own code
  // (ADR-0008). On a text layer the Outline branch (SPM-18) previews the
  // RESTYLED TEXT — the very render Apply commits — so the preview is the
  // result there too: the layer keeps its glyphs and gains a ring, shown
  // through the same override the pixel effects draw into.
  const preview = new EffectPreview<EffectResult>(
    async (req) => {
      const layer = req.doc.layers[layerIndex(req.doc, req.layerId)];
      const patch = outlineTextPatch(req.effect, layer);
      if (patch) {
        // The transform the model's setTextStyle will land (anchoredTransform):
        // the box grows around the text, so the preview shows it at its
        // final place, not where the old box's corner was.
        const drawn = await outlinedTextRender(patch.layer, patch.outline);
        return { image: drawn.render.image, transform: drawn.transform };
      }
      return applyEffect(layerInput(layer), req.effect);
    },
    (req, result) => stage?.setOverride(req && result ? { id: req.layerId, ...result } : null),
    (err) => say(errorMessage(err)),
  );
  // The warp press in progress, if any.
  let warp: WarpInProgress | null = null;
  // What the Outline/Glow tool was chosen on: the document and its target.
  // A change of either discards the preview AND returns to Move (owner
  // decisions 2026-11-22, CMT-243 and after).
  let basis: EffectBasis | null = null;
  const pasteTitle = "Paste (Ctrl+V) — Paste an image from the clipboard as a new layer";
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
  // The outline controls (SPM-18): a colour picker with its eyedropper and
  // a width field like the font size's. Width 0 means no outline — the
  // style's outline is null then, so 0 is also how an outline is removed.
  // The labels say "text outline" because the effect bar's own Outline
  // colour picker shares the page (hidden while the tool is off).
  const outlineColorInput = el("input", { class: "editor-color-input", type: "color", "aria-label": "Text outline colour" }) as HTMLInputElement;
  const outlineWidthInput = el("input", {
    class: "editor-side-input",
    type: "number",
    min: String(TEXT_OUTLINE_WIDTH.min),
    max: String(TEXT_OUTLINE_WIDTH.max),
    step: "1",
    "aria-label": "Text outline width in pixels",
  }) as HTMLInputElement;
  // The text controls' busy/text-reason disable loop; the eyedroppers beside
  // the colour pickers enroll themselves (owner decision 2026-11-23) and
  // start canvas picks whose samples follow the pickers' own paths.
  const textControls: { disabled: boolean }[] = [fontPicker, fontSizeInput, colorInput, outlineColorInput, outlineWidthInput];
  const textEyedropper = eyedropperButton(
    () =>
      stage?.beginColorPick((hex) => {
        colorInput.value = hex;
        restyle({ color: hex });
      }),
    textControls,
  );
  const outlineEyedropper = eyedropperButton(
    () =>
      stage?.beginColorPick((hex) => {
        outlineColorInput.value = hex;
        const width = shownOutline()?.width ?? 0;
        if (width > 0) restyle({ outline: { color: hex, width } });
      }),
    textControls,
  );
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
  // The outline the text controls act on: the first selected text layer's,
  // else the next new text's (the same `shown` the refresh below syncs from).
  function shownOutline() {
    const texts = session?.selectedTexts ?? [];
    return texts.length > 0 ? texts[0].outline : nextStyle.outline;
  }
  // An outline colour change commits only when an outline exists (a width
  // above 0): with none it commits nothing and the picker KEEPS the choice
  // — the next width commit takes it along, so colour first, width second
  // works too.
  outlineColorInput.addEventListener("change", () => {
    if (isHexColor(outlineColorInput.value)) {
      const width = shownOutline()?.width ?? 0;
      if (width > 0) restyle({ outline: { color: outlineColorInput.value.toLowerCase(), width } });
    }
    outlineColorInput.blur();
  });
  outlineWidthInput.addEventListener("change", () => {
    // Empty reverts like every slider field's rule (SPEC §6, owner decision
    // 2026-11-23): it never means 0, which would silently remove the outline.
    const raw = outlineWidthInput.value.trim();
    const width = raw === "" ? NaN : Number(raw);
    const problem = outlineWidthProblem(width);
    if (problem) {
      say(problem);
      refresh(); // shows the current width again
      return;
    }
    // The colour the picker shows rides along, so width first, colour
    // second is the natural order; 0 removes the outline (the null style).
    const color = outlineColorInput.value.toLowerCase();
    restyle({ outline: width === 0 ? null : { color, width } });
    outlineWidthInput.blur();
  });
  // Background removal and the refine brush (SPM-7): on the selected image layer, or the base image.
  const removeBackgroundButton = button("Remove background", () => run(removeBackground));
  const removeBackgroundTitle =
    "Remove background — Make the background of the selected image layer (or the base image) transparent; works offline after a one-time model download";
  const eraseToolButton = button("Erase", () => setTool("erase"));
  const restoreToolButton = button("Restore", () => setTool("restore"));
  eraseToolButton.title = toolTitle("Erase", "erase", "Paint on the selected image layer (or the base image) to make it transparent");
  restoreToolButton.title = toolTitle(
    "Restore",
    "restore",
    "Paint on the selected image layer (or the base image) to bring back what was removed or erased",
  );
  const brushSizeInput = el("input", {
    class: "editor-side-input",
    type: "number",
    min: String(BRUSH_SIZE.min),
    max: String(BRUSH_SIZE.max),
    step: "1",
    value: String(BRUSH_SIZE.initial),
    "aria-label": "Brush size",
  }) as HTMLInputElement;
  brushSizeInput.title = `Brush — The brush size in canvas px (${BRUSH_SIZE.min}–${BRUSH_SIZE.max})`;
  let brushSize: number = BRUSH_SIZE.initial;
  brushSizeInput.addEventListener("change", () => {
    const size = Number(brushSizeInput.value);
    const problem = brushSizeProblem(size);
    if (problem) {
      say(problem);
      brushSizeInput.value = String(brushSize);
      return;
    }
    say(""); // a valid size replaces an earlier complaint, as any command does
    brushSize = size;
    stage?.setBrushSize(size);
    brushSizeInput.blur();
  });
  // The wand tool's tolerance (SPM-22): how far each colour channel may
  // drift from the clicked sample, as a percent of full range.
  let tolerance: number = TOLERANCE.initial;
  const toleranceInput = el("input", {
    class: "editor-side-input",
    type: "number",
    min: String(TOLERANCE.min),
    max: String(TOLERANCE.max),
    step: "1",
    value: String(TOLERANCE.initial),
    "aria-label": "Tolerance",
  }) as HTMLInputElement;
  toleranceInput.title = `Tolerance — How far each colour channel may drift from the clicked sample, in percent (${TOLERANCE.min}–${TOLERANCE.max})`;
  toleranceInput.addEventListener("change", () => {
    const value = Number(toleranceInput.value);
    const problem = toleranceProblem(value);
    if (problem) {
      say(problem);
      toleranceInput.value = String(tolerance);
      return;
    }
    say(""); // a valid tolerance replaces an earlier complaint, as any command does
    tolerance = value;
    toleranceInput.blur();
  });
  // The selection's 1-px feather, on by default (owner decision 2026-11-24):
  // a checkbox beside the tolerance. It governs every contribution a
  // selection is built from — a wand fill, and since SPM-23 a Rectangle or
  // Lasso polygon composed onto one — from the next one on.
  let feathered = true;
  const featherInput = el("input", { type: "checkbox", "aria-label": "Feather" }) as HTMLInputElement;
  featherInput.checked = true;
  featherInput.title = "Feather — Soften the selection's edge by half a pixel; uncheck it for hard edges";
  featherInput.addEventListener("change", () => {
    feathered = featherInput.checked;
    featherInput.blur();
  });
  // The message-line text of a model download in progress, null when none
  // runs: Save's disabled tooltip and a mid-download Ctrl+S say it (SPEC §6,
  // §2: a disabled control shows its reason).
  let downloadNote: string | null = null;
  // Shown only while the model downloads; stays usable while everything else waits.
  const cancelDownloadButton = button("Cancel download", () => void cancelBackgroundDownload());
  cancelDownloadButton.hidden = true;
  const textTitle =
    "Add text — Type a new text layer in the chosen font, size and colour (Enter to finish, Shift+Enter for a new line)";
  const editTextTitle = "Edit text — Edit the selected text layer's text (or double-click it)";

  // Tooltips follow the §2 contract: Name (Shortcut) — one-line description.
  // Sizing and crop have no single-key shortcut, so their names stand alone.
  const undoTitle = "Undo (Ctrl+Z) — Step back: the selection's own steps first, then the document's changes";
  const redoTitle = "Redo (Ctrl+Y) — Step forward again: the selection's own steps first, then the document's changes";
  undoButton.title = undoTitle;
  redoButton.title = redoTitle;
  const sideWord = () => (freeSide === "longest" ? "long" : "short");
  const resizeTitle = () =>
    `Resize — Scale everything on the canvas together so its ${sideWord()} side is the entered size ` +
    `(1–${IMPORT_MAX_SIDE} px); the canvas size stays`;
  resizeButton.title = resizeTitle();
  sideKind.title = "Long side — The entered size applies to the image's longest side (Short side: its shortest)";
  resetViewButton.title = "Reset view — Zoom and centre the canvas in view (changes the view only)";
  const upTitle = "Move up — Move the selected layer up the stack";
  const downTitle = "Move down — Move the selected layer down the stack";
  upButton.title = upTitle;
  downButton.title = downTitle;
  boxButton.title = "Guide — Show or hide the crop guide";
  const cropTitle = (size: string) =>
    `Crop to ${size} — Discard everything outside the ${size} box; drag the image to choose what stays. The canvas size stays`;
  closeButton.title = "Close — End the editing session; asks first while there are unsaved changes";
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

  // A thin vertical rule between two of the top row's groups. Its 8px
  // margins on BOTH sides own the row's spacing (owner, 2026-11-25: the old
  // group borders gave 8px left and 3px right); the row's own gap is 0.
  const rule = () => el("span", { class: "editor-sep", "aria-hidden": "true" });

  // The top row (SPEC §6 Layout): Undo, Redo | the sizing tools | the
  // free-resize sentence | Guide, Crop to {size} | spacer | Save…, Close.
  const toolbar = el(
    "div",
    { class: "editor-toolbar" },
    el(
      "span",
      { class: "editor-tool-group", role: "group", "aria-label": "Session" },
      undoButton,
      redoButton,
    ),
    rule(),
    el(
      "span",
      { class: "editor-tool-group", role: "group", "aria-label": "Size" },
      fitButton,
      fillButton,
      longestButton,
    ),
    rule(),
    el(
      "span",
      { class: "editor-tool-group", role: "group", "aria-label": "Free resize" },
      el("span", { class: "editor-side" }, sideKind, " side", sideInput, " px"),
      resizeButton,
    ),
    rule(),
    el(
      "span",
      { class: "editor-tool-group", role: "group", "aria-label": "Crop" },
      boxButton,
      cropButton,
    ),
    el("span", { class: "editor-spacer" }),
    rule(),
    el("span", { class: "editor-session-actions", role: "group", "aria-label": "Session actions" }, saveButton, closeButton),
  );

  // ---- The left tabbed tools panel (SPEC §6 Layout, SPM-15 D2) ----
  //
  // Browser-style tab leaves on the panel's own top edge: the active leaf
  // merges into the body (its bottom border interrupts the body's top
  // border, body background), the inactive leaves are shorter and dimmer on
  // --bg. One category is visible at a time; Select is the default. The four
  // text leaves total wider than the 192px panel and OVERHANG its right edge
  // over the canvas — the owner-accepted state until the labels become icons
  // (owner decision 2026-11-25); the leaves are deliberately not shrunk
  // (editor.css carries the same note).
  //
  // The active tab is panel state, not tool state: a tab click shows its
  // category and STAYS until another rule fires. Tool activations surface
  // their category through setTool (below), and opening text editing
  // surfaces Text (editText), so nothing else ever moves the panel.
  type TabGroup<K extends string> = {
    readonly buttons: Record<K, HTMLButtonElement>;
    /** The tablist row, ready to mount. */
    readonly row: HTMLElement;
    /** A section for one tab, wired to its leaf; call show() once all exist. */
    readonly section: (name: K, ...children: HTMLElement[]) => HTMLElement;
    readonly show: (name: K) => void;
  };

  /**
   * One tab system's leaves and panels, shared by both side panels (SPM-15):
   * same leaves, same aria wiring, same one-visible-category rule. Only the
   * group names its ids ("editor-tool-…" / "editor-layer-…") and chooses its
   * section class; the left panel's browser-style leaves are the common CSS.
   */
  function tabSet<K extends string>(
    group: "tool" | "layer",
    names: readonly K[],
    labels: Record<K, string>,
    tablistLabel: string,
  ): TabGroup<K> {
    const buttons = {} as Record<K, HTMLButtonElement>;
    const sections = {} as Record<K, HTMLElement>;
    const show = (name: K): void => {
      for (const tab of names) {
        buttons[tab].setAttribute("aria-selected", String(tab === name));
        sections[tab].hidden = tab !== name;
      }
    };
    for (const name of names) {
      buttons[name] = el(
        "button",
        {
          class: "editor-tool-tab",
          type: "button",
          role: "tab",
          id: `editor-${group}-tab-${name}`,
          "aria-selected": "false",
          "aria-controls": `editor-${group}-panel-${name}`,
          onclick: () => show(name),
        },
        labels[name],
      ) as HTMLButtonElement;
    }
    const row = el(
      "div",
      { class: "editor-tabrow", role: "tablist", "aria-label": tablistLabel },
      ...names.map((name) => buttons[name]),
    );
    const section = (name: K, ...children: HTMLElement[]): HTMLElement => {
      const panel = el(
        "section",
        {
          class: group === "tool" ? "editor-tool-section" : "editor-tabpanel",
          role: "tabpanel",
          id: `editor-${group}-panel-${name}`,
          "aria-labelledby": `editor-${group}-tab-${name}`,
          hidden: true,
        },
        ...children,
      );
      sections[name] = panel;
      return panel;
    };
    return { buttons, row, section, show };
  }

  const leftTabs = tabSet(
    "tool",
    ["select", "paint", "effects", "text"] as const,
    { select: "Select", paint: "Paint", effects: "Effects", text: "Text" },
    "Tool categories",
  );
  leftTabs.buttons.select.title = "Select — Move and select layers, cut and paste";
  leftTabs.buttons.paint.title = "Paint — Erase, restore and warp pixels, and remove the background";
  leftTabs.buttons.effects.title = "Effects — Outline or glow the selected layer";
  leftTabs.buttons.text.title = toolTitle("Text", "text-tab", "Add and style text layers");
  const toolList = (...buttons: HTMLElement[]): HTMLElement => el("div", { class: "editor-tool-list" }, ...buttons);
  const toolSection = (name: ToolsPanelTab, title: string, ...children: HTMLElement[]): HTMLElement =>
    leftTabs.section(name, el("h3", { class: "editor-tool-section-title" }, title), ...children);

  // Select: the four selection tools, their two fields, then Cut and Paste.
  const selectSection = toolSection(
    "select",
    "Select",
    toolList(moveToolButton, rectToolButton, lassoToolButton, wandToolButton),
    el("label", { class: "editor-field editor-field-indent" }, "Tolerance ", toleranceInput, " %"),
    // The checkbox's own 4px UA inset is the row convention's source: every
    // field row takes the same 4px, so they share one left inset.
    el("label", { class: "editor-field" }, featherInput, " Feather"),
    el("hr", { class: "editor-panel-sep" }),
    toolList(cutButton, pasteButton),
  );

  // Paint: the refine brushes with their size, background removal (it stays
  // with its brushes, owner decision 2026-11-25), and Warp's settings.
  const paintSection = toolSection(
    "paint",
    "Paint",
    toolList(eraseToolButton, restoreToolButton, warpToolButton),
    el("label", { class: "editor-field editor-field-indent" }, "Brush ", brushSizeInput, " px"),
    toolList(removeBackgroundButton, cancelDownloadButton),
    effectControls.warpBlock,
  );

  // Effects: the two effect tools, each one's settings beneath, then the
  // Apply/Cancel pair centred in the panel (owner revision r3).
  const effectsSection = toolSection(
    "effects",
    "Effects",
    toolList(outlineToolButton, glowToolButton),
    effectControls.outlineBlock,
    effectControls.glowBlock,
    effectControls.actions,
  );

  // Text: the two text actions and the six style controls. The two colour
  // rows gain small visible captions because an unlabelled swatch is
  // ambiguous once it leaves a labelled toolbar row; inputs, aria-labels and
  // titles are the app's own.
  const textSection = toolSection(
    "text",
    "Text",
    toolList(textButton, editTextButton),
    fontPicker.element,
    el("label", { class: "editor-field editor-field-indent" }, "Size ", fontSizeInput, " px"),
    el(
      "div",
      { class: "editor-field editor-field-indent" },
      el("span", { class: "editor-cap" }, "Text colour"),
      colorInput,
      textEyedropper,
    ),
    el(
      "div",
      { class: "editor-field editor-field-indent" },
      el("span", { class: "editor-cap" }, "Outline colour"),
      outlineColorInput,
      outlineEyedropper,
    ),
    el("label", { class: "editor-field editor-field-indent" }, "Outline ", outlineWidthInput, " px"),
  );

  /** Show one category; the tab leaves and the body follow. */
  const showPanel = leftTabs.show;

  const toolsPanel = el(
    "aside",
    { class: "editor-tools", "aria-label": "Tools" },
    leftTabs.row,
    el("div", { class: "editor-tools-body" }, selectSection, paintSection, effectsSection, textSection),
  );
  showPanel("select");

  // ---- The right tabbed panel (SPEC §6 Layout, SPM-15 D3) ----
  //
  // The same browser-style tab leaves stuck on the panel's top edge as the
  // tools panel (owner decision 2026-11-25): Layers is the default, Actions
  // is a read-only history, Emoji is the session's Emoji String box. The
  // Emoji leaf is the ONE place the modes' geometry differs — it hides in
  // Thumbnail mode, because that mode has no sticker to hold the string
  // (owner decision 2026-11-25). The Editor view is built once and cached,
  // so that visibility is recomputed from `constraints.mode` on EVERY
  // refresh(), never set once; a Thumbnail session handing off to a Sticker
  // session must bring the leaf back (owner's live-test note). The panel
  // goes back to Layers whenever the visible tab set changes.
  // The Emoji leaf's last applied hidden state; null until the first session.
  let emojiLeafHidden: boolean | null = null;

  const rightTabs = tabSet(
    "layer",
    ["layers", "actions", "emoji"] as const,
    { layers: "Layers", actions: "Actions", emoji: "Emoji" },
    "Layers, actions and emoji",
  );
  rightTabs.buttons.layers.title =
    "Layers — The layer stack, top first; click a row to select a layer (Ctrl-click toggles)";
  rightTabs.buttons.actions.title = "Actions — Every undoable action this session, oldest first (read-only for now)";
  rightTabs.buttons.emoji.title = "Emoji — The sticker's Emoji String; 1–20 emoji, empty allowed";
  const rightSection = rightTabs.section;

  // Layers: the list in its bounding box, the actions BELOW the box's bottom
  // edge and outside it (owner decision 2026-11-25), then the hint. The grid
  // cells are the owner's r6 split: Add (a tall, picker-opening cell across
  // rows 1–2) over Delete on the left, Move up / Move down / Merge selected
  // in the right column (editor.css owns the placement).
  addButton.classList.add("editor-cell-add");
  deleteButton.classList.add("editor-cell-delete");
  upButton.classList.add("editor-cell-up");
  downButton.classList.add("editor-cell-down");
  mergeButton.classList.add("editor-cell-merge");
  const layersSection = rightSection(
    "layers",
    el("div", { class: "editor-listbox" }, layersList),
    el(
      "div",
      { class: "editor-layer-actions", role: "group", "aria-label": "Layer actions" },
      addButton,
      deleteButton,
      upButton,
      downButton,
      mergeButton,
    ),
    layerHint,
  );

  // Actions: a READ-ONLY list of the document trail with the selection's
  // steps nested under Select (see src/editor/view/actions-list.ts).
  const actionsList = el("ol", { class: "editor-actions-list", "aria-label": "Action history" });
  const actionsSection = rightSection(
    "actions",
    el("div", { class: "editor-listbox" }, actionsList),
    el("p", { class: "editor-note muted" }, "Read-only for now: jumping to an earlier step is planned."),
  );

  // Emoji: the session's Emoji String in a fixed five-row box (SPEC §6
  // Layout). It never resizes; its internal scrollbar is the overflow
  // safety valve only. Validation is warn-only and lands in the message row.
  const emojiLabel = el("label", { class: "editor-emoji-label", for: "editor-emoji-input" }, "Emoji String");
  const emojiInput = el("textarea", {
    class: "editor-emoji-input",
    id: "editor-emoji-input",
    rows: "5",
    spellcheck: "false",
    "aria-label": "Emoji String",
  }) as HTMLTextAreaElement;
  emojiInput.addEventListener("keydown", (e) => {
    // Enter commits and gives up focus, so the editor's shortcuts work at
    // once (the house rule); a textarea must never take a newline here.
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    emojiInput.blur(); // the blur handler commits
  });
  emojiInput.addEventListener("blur", () => void commitEmoji());
  const emojiSection = rightSection(
    "emoji",
    emojiLabel,
    emojiInput,
    el(
      "p",
      { class: "editor-hint muted" },
      "1–20 emoji — a warning shows past 20; empty is allowed. The box holds five rows and never resizes.",
    ),
  );

  /** Show one right-panel tab; its leaf and section follow. */
  const showRightTab = rightTabs.show;

  const layersPanel = el(
    "aside",
    { class: "editor-layers", "aria-label": "Layers, actions and emoji" },
    rightTabs.row,
    el("div", { class: "editor-tools-body" }, layersSection, actionsSection, emojiSection),
  );
  showRightTab("layers");

  // The bottom status strip (SPEC §6 Layout, owner 2026-11-25): the live
  // readout on the left; zoom, Reset view and the unsaved-changes dot on the
  // right, in that order. Placement only: every behaviour is unchanged.
  const statusRight = el(
    "span",
    { class: "editor-status-right", role: "group", "aria-label": "View status" },
    zoomLabel,
    resetViewButton,
    dirtyLabel,
  );
  const statusStrip = el("div", { class: "editor-status" }, readout, statusRight);

  const workspace = el("div", { class: "editor-workspace" }, toolsPanel, canvasHost, layersPanel);
  // The wheel over the typing overlay zooms the canvas like anywhere else (owner re-test 2026-11-22).
  const textOverlay = new TextEditOverlay(canvasHost, (e) => stage?.zoomAtClient(e.clientX, e.clientY, e.deltaY));
  const view = el(
    "section",
    { class: "view editor" },
    toolbar,
    // The reserved message row sits directly under the top row (SPEC §6).
    message,
    empty,
    workspace,
    statusStrip,
  );

  /**
   * Show a line in the message area: an error or blocked-action reason in
   * red, or a neutral note (`"note"`, e.g. after Crop converted text).
   * `run()` clears the line (and its tone) with `say("")` before an action,
   * so errors that `withMessage` writes directly always show in the error tone.
   */
  function say(text: string, tone: "error" | "note" = "error", ...extra: (Node | string)[]): void {
    message.replaceChildren(text, ...extra);
    message.classList.toggle("is-note", tone === "note");
  }

  /**
   * Commit the Emoji String box (SPEC §6 Layout): Enter or blur commits —
   * staged for a fresh image, written straight through for an origin
   * sticker — and the warn-only count warning shows in the message row
   * (never a block). A blur with no change is not a command and clears
   * nothing; a blocked box never writes.
   */
  async function commitEmoji(): Promise<void> {
    const current = emoji;
    if (!current || current.blocked || busy) return;
    const typed = emojiInput.value;
    if (typed === current.value) return; // nothing changed
    try {
      const stored = await current.commit(typed);
      if (emoji !== current) return; // the session changed under the await
      emojiInput.value = stored;
      const warning = current.warning;
      if (warning) say(warning, "note");
      else if (message.classList.contains("is-note")) say(""); // the warning (or note) it replaced
    } catch (err) {
      say(errorMessage(err));
    }
  }

  /**
   * The saved note's link (owner decision 2026-11-22): a link-styled button
   * that shows the saved sticker in the Pack Manager, leaving this session
   * as it is. A sticker gone since (deleted, moved) is reported here instead.
   */
  function stickerLink(sticker: Sticker, packTitle: string): HTMLElement {
    const { text, label } = showStickerLink(sticker, packTitle);
    const link = el("button", { type: "button", class: "editor-link", "aria-label": label, title: label }, text);
    // Not through run(): that clears the message line, and the note (with its link) should stay.
    const generation = libraryGeneration;
    link.addEventListener("click", async () => {
      if (busy) return;
      // Its ids belong to the Library it was saved into: never look them up in another.
      if (generation !== libraryGeneration) {
        say(stickerGoneText(sticker.position, packTitle, true));
        return;
      }
      let present = false;
      try {
        present = (await loadPackView(sticker.packId)).stickers.some((s) => s.id === sticker.id);
      } catch {
        // the pack is gone too
      }
      if (!present) say(stickerGoneText(sticker.position, packTitle));
      else editorNav?.showSticker(sticker.packId, sticker.id);
    });
    return link;
  }

  /**
   * The saved note's link for a thumbnail save (SPM-12), mirroring stickerLink:
   * shows the pack's thumbnail slot in the Pack Manager, this session staying
   * as it is. A pack gone since (deleted, another Library) is reported here.
   */
  function thumbnailLink(packId: number, packTitle: string): HTMLElement {
    const { text, label } = showThumbnailLink(packTitle);
    const link = el("button", { type: "button", class: "editor-link", "aria-label": label, title: label }, text);
    // Not through run(): that clears the message line, and the note (with its link) should stay.
    const generation = libraryGeneration;
    link.addEventListener("click", async () => {
      if (busy) return;
      // Its ids belong to the Library it was saved into: never look them up in another.
      if (generation !== libraryGeneration) {
        say(thumbnailGoneText(packTitle, true));
        return;
      }
      try {
        await loadPackView(packId);
        editorNav?.showThumbnail(packId);
      } catch {
        // the pack is gone
        say(thumbnailGoneText(packTitle));
      }
    });
    return link;
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

  /**
   * Start the one session with `picked`: adopt the mode's constraint set and
   * origins, then build the stage (the wiring both entry modes share, in
   * one place). The set's mode decides which origin is meaningful.
   */
  function startSession(
    picked: { image: RgbaImage; name: string },
    set: ConstraintSet,
    stickerFrom: StickerOrigin | null,
    thumbnailFrom: ThumbnailOrigin | null,
  ): void {
    constraints = set;
    origin = stickerFrom;
    thumbnailOrigin = thumbnailFrom;
    emoji = new SessionEmoji(
      stickerFrom
        ? {
            kind: "origin",
            stickerId: stickerFrom.stickerId,
            packId: stickerFrom.packId,
            otherLibrary: stickerFrom.otherLibrary ?? false,
          }
        : { kind: "staged" },
      emojiStore,
    );
    const startedEmoji = emoji;
    // An origin sticker's string is read once; the box shows it when it
    // arrives (a gone origin disables the box with its reason). A staged
    // session resolves at once and paints the empty box.
    void startedEmoji.load().then(() => {
      if (emoji === startedEmoji) refresh();
    });
    session = new EditorSession(newDocument(picked.image, picked.name, startCanvas(set)));
    refresh(); // show the workspace so the stage measures its real size
    stage = new EditorStage(canvasHost, session);
    stage.setCropGuidesVisible(showBox);
    stage.setTool(tool);
    stage.onEditText((id) => editText(id));
    stage.onBrush({ press: beginWarp, move: continueWarp, release: endWarp });
    stage.onWand({ press: beginWand, move: continueWand, release: endWand });
    stage.onCompose({ compose: composeShape });
    stage.setBrushSize(brushSize);
    stage.onBrushBlocked((reason) => say(reason));
    stage.onPickBlocked((reason) => say(reason));
    refresh(); // place the crop box overlay
    // Subscribe AFTER the stage: on every change the canvas redraws first,
    // so refresh() measures current content (Fit's enabled state).
    session.subscribe(refresh);
    stage.onViewChange((v) => {
      zoomLabel.textContent = `${Math.round(v.scale * 100)}%`;
      placeTextOverlay(v); // typing overlay follows pan and zoom
    });
  }

  async function openImage(path?: string, from: StickerOrigin | null = null): Promise<void> {
    if (session) return; // one session at a time: Close first
    const picked = await pickAndImport(path);
    if (!picked) return;
    startSession(picked, STICKER, from, null);
  }

  async function addImageAsLayer(): Promise<void> {
    const current = session;
    if (!current) return;
    const picked = await pickAndImport();
    if (!picked) return;
    const id = nextLayerId(current.doc);
    current.apply("Add image as layer", (doc) => addRasterLayer(doc, picked.image, picked.name, centeredPlacement(doc, picked.image)));
    current.select(id);
  }

  /**
   * Open the image at `path` in Thumbnail mode (SPM-12): the canvas starts
   * at the thumbnail side square and the session saves into `from`'s pack.
   * One session at a time, guaranteed by the hook that calls here.
   */
  async function openThumbnail(path: string, from: ThumbnailOrigin): Promise<void> {
    if (session) return; // one session at a time: Close first
    const picked = await pickAndImport(path);
    if (!picked) return;
    startSession(picked, THUMBNAIL, null, from);
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
        current.apply("Merge layers", (d) =>
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
        current.apply("Crop", (d) => cropLayers(d, plan, byId));
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
    const box = cropBox(doc, constraints.side);
    const plan = planCrop(doc, box);
    return { box, plan, blocker: cropBlocker(plan, box) };
  }

  function toggleBox(): void {
    showBox = !showBox;
    stage?.setCropGuidesVisible(showBox);
    refresh();
  }

  /**
   * End the session, asking first when it has unsaved changes, or when a
   * clean session's origin sticker is gone (Close, and opening another
   * image from the Pack Manager). Resolves false when the user keeps
   * editing, so the session stays.
   */
  async function closeSession(): Promise<boolean> {
    if (!session) return true;
    // An unapplied effect preview alone is not a change (CMT-186): it is dropped.
    if (session.isDirty && !(await confirmDiscard())) return false;
    // A CLEAN session whose origin sticker is gone (deleted, sent away with
    // Move, or the Library changed) asks before closing throws its last
    // copy away (owner decision 2026-11-23). The save dialog's own lookup
    // decides, so Replace-gone and this warning can never disagree; a dirty
    // session never reaches here (its warning has decided), and one without
    // an origin (a plain file, never saved into a slot) never warns. A
    // Thumbnail mode session deliberately never warns either: its origin is
    // a pack, not the only copy of an image (SPEC §6 warns for origin
    // stickers only), and `origin` stays null there.
    if (!session.isDirty && origin && originGoneCloseWarning(origin, await originNow(origin))) {
      if (!(await confirmCloseOriginGone())) return false;
    }
    endSession();
    return true;
  }

  /** End the session at once, unsaved changes included (the caller has asked). */
  function endSession(): void {
    preview.request(null);
    warp = null;
    basis = null;
    origin = null;
    thumbnailOrigin = null;
    emoji = null;
    // Back to the default set: the toolbar's labels and rules read it.
    constraints = STICKER;
    textOverlay.close();
    stage?.destroy();
    stage = null;
    session = null;
    tool = "move";
    // The no-session UI shows at once: the effect bar hides and no tool
    // button stays pressed (SPM-8). run()'s closing refresh covers the
    // button-and-close paths, but ending a session must not depend on it.
    refresh();
  }

  // ---- Save (SPM-10) ----

  /**
   * The over-cap save flow both modes share (owner decision 2026-11-21,
   * CMT-144): save in `format` to `target`; a PNG over the cap offers WEBP.
   * Resolves the saved outcome; the line that keeps the save dialog open
   * (nothing was saved: the PNG was declined); or null when the dialog
   * should close without a save because the cap was exhausted -
   * `onExhausted` then received the outcome for the question that follows
   * the dialog. The target decides the saved outcome's kind, so the caller
   * narrows it.
   */
  async function saveTo(
    doc: Doc,
    format: SaveFormat,
    target: SaveTarget,
    setFormat: (format: SaveFormat) => void,
    onExhausted: (outcome: TooLarge) => void,
  ): Promise<SaveOutcome | string | null> {
    const result = await runSave(format, {
      save: (f) => saveImage(doc, f, target, emoji?.forSave(target.kind) ?? ""),
      offerWebp: async (outcome) => {
        const ok = await confirmWebp(pngTooLargeText(outcome));
        if (ok) setFormat("webp");
        return ok;
      },
    });
    if (result.kind === "declined") return declinedText(result.outcome);
    if (result.kind === "exhausted") {
      onExhausted(result.outcome);
      return null; // the save dialog closes; the question below follows
    }
    return result.outcome;
  }

  /**
   * Save (SPEC §6, hard-blocked): the save dialog picks the pack and the
   * format; Rust flattens what is inside the canvas, encodes it within the
   * size cap and appends it to the pack. A PNG over the cap offers WEBP; a
   * WEBP over the cap even at its lowest quality sends the user back to the
   * Editor (owner decision 2026-11-21, CMT-144). A save clears the unsaved
   * changes; the session stays open. A Thumbnail mode session (SPM-12) runs
   * the same flow into the pack's thumbnail instead: the pack is already
   * chosen, so its dialog picks only the format.
   */
  async function saveSession(): Promise<void> {
    const current = session;
    if (!current) return;
    // A mid-press stroke — Erase/Restore (SPM-7) or Warp (SPM-8) — owns pixels
    // the model does not have yet: the dialog would save the document without
    // them, and the stroke's release would commit them under it. Both save
    // entry points refuse here (owner decision 2026-11-23); the canvas rule
    // follows once no stroke runs.
    const refusal = saveRefusal(stage?.strokeInProgress() ?? false, current.doc, constraints);
    if (refusal) return say(refusal);
    const doc = current.doc;
    // The Emoji tab's value the dialog's hint reads; for an origin session a
    // "Save as a new sticker" carries the sticker's own string (SPEC §6).
    await emoji?.load();
    let exhausted: TooLarge | null = null;
    if (constraints.mode === "thumbnail") {
      // Thumbnail mode (SPM-12): the pack is the session's origin, already
      // chosen; only the format is picked. The over-cap flow is the same
      // owner decision as a sticker save (CMT-144).
      const from = thumbnailOrigin;
      if (!from) return; // unreachable: a thumbnail session always has one
      await thumbnailSaveDialog({
        constraints,
        format: lastFormat,
        origin: from,
        submit: async (choice, setFormat) => {
          const { format } = choice;
          const target: SaveTarget = { kind: "thumbnail", packId: from.packId };
          const saved = await saveTo(doc, format, target, setFormat, (outcome) => {
            exhausted = outcome;
          });
          // Nothing was saved: the declined line stays in the dialog, or the exhausted
          // null closes it for the give-up question below.
          if (saved === null || typeof saved === "string") return saved;
          const outcome = saved as SavedThumbnail; // the target decides the saved kind; TS cannot see it
          // The open pack view must not keep showing the old thumbnail picture.
          markThumbnailChanged(outcome.pack.id);
          lastFormat = format;
          // An Erase, Restore or Warp press could commit under this dialog; the
          // mid-stroke refusal above makes that known path impossible. The
          // check stays as defence in depth for anything unforeseen.
          if (current.doc === doc) current.markSaved();
          say(
            thumbnailSavedText(outcome.pack, outcome.bytes, outcome.quality),
            "note",
            " ",
            thumbnailLink(outcome.pack.id, outcome.pack.title),
          );
          return null;
        },
      });
    } else {
      await saveDialog({
        constraints,
        format: lastFormat,
        origin,
        emojiString: emoji?.forSave("append") ?? "",
        submit: async (choice, setFormat) => {
          const { format } = choice;
          const target: SaveTarget =
            choice.kind === "replace"
              ? { kind: "replace", stickerId: choice.origin.stickerId }
              : { kind: "append", packId: choice.pack.id };
          const packTitle = choice.kind === "replace" ? choice.now.packTitle : choice.pack.title;
          const saved = await saveTo(doc, format, target, setFormat, (outcome) => {
            exhausted = outcome;
          });
          // Nothing was saved: the declined line stays in the dialog, or the exhausted
          // null closes it for the give-up question below.
          if (saved === null || typeof saved === "string") return saved;
          const outcome = saved as Saved; // the target decides the saved kind; TS cannot see it
          packMemory.lastSavedPackId = outcome.sticker.packId;
          lastFormat = outcome.sticker.format;
          // The open pack view must not keep showing the old picture of a replaced sticker.
          if (target.kind === "replace") markStickerFileChanged(outcome.sticker.id);
          // The session now edits the saved sticker: the next save replaces it (design decision 2026-11-22).
          origin = originAfterSave(outcome, packTitle);
          // …and its Emoji String is the box's value from now on (SPEC §6 Layout, SPM-15).
          emoji?.afterSave(outcome.sticker);
          // An Erase, Restore or Warp press could commit under this dialog; the
          // mid-stroke refusal above makes that known path impossible. The
          // check stays as defence in depth for anything unforeseen.
          if (current.doc === doc) current.markSaved();
          say(savedText(outcome, packTitle, target), "note", " ", stickerLink(outcome.sticker, packTitle));
          return null;
        },
      });
    }
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
    basis = session && effectKindOf(next) ? effectBasis(session.doc, session.selection) : null;
    stage?.setTool(next);
    // EVERY tool activation surfaces its category (SPEC §6 Layout): the
    // buttons and the single-key shortcuts both land here, and so do the
    // automatic returns to Move after Cut, Apply and a discarded preview.
    showPanel(TOOL_PANEL[next]);
    refresh();
  }

  /**
   * The cut a selection takes from one raster layer (SPM-9; the wand since
   * SPM-22; composed since SPM-23): a plain Rectangle/Lasso moves its whole
   * pixels, while a floating selection merges into the layer's own grid
   * first — the apply is authoritative there, the document-grid preview was
   * display only — so a wand fill is used where it was drawn and a polygon
   * rasterises like a plain one's.
   */
  async function cutFor(source: RasterLayer, region: Region): Promise<CutResult> {
    if (region.kind !== "compose") return cutImage(source.image, source.transform, region.points);
    return liftMask(source.image, source.transform, await composeMaskFor(source, region, NOTHING_TO_CUT));
  }

  /**
   * The coverage a composed selection merges into `source`'s own pixel grid
   * (SPM-23): a merge that comes back empty is refused with `nothing`, the
   * calling tool's own wording. Callers handle a plain Rectangle/Lasso region
   * with their whole-pixel primitive instead.
   */
  async function composeMaskFor(source: RasterLayer, region: ComposedRegion, nothing: string): Promise<WandMask> {
    const mask = await composeSelection(source.image.width, source.image.height, source.transform, region.contributions);
    if (mask.width === 0 || mask.height === 0) throw new Error(nothing);
    return mask;
  }

  /**
   * Cut (SPM-9, the wand since SPM-22, composed since SPM-23): the selected
   * pixels of the cut selection's layer move into a new floating layer at
   * the same spot, as ONE undo step; the pixel work is Rust's. The selection
   * is used up, and the Move tool comes back so the cutout can be dragged
   * and resized at once.
   */
  async function cutSelection(): Promise<void> {
    const current = session;
    if (!current || cutBlocker(current.doc, current.selection, current.region)) return;
    const region = current.region!;
    await editAsync(
      current,
      { doing: "cutting", done: "cut" },
      async (doc) => {
        // The blockers gated exactly one selected image layer: Cut lifts from it.
        const source = doc.layers[layerIndex(doc, current.selection[0])];
        if (source.kind !== "raster") return null;
        return { source, cut: await cutFor(source, region) };
      },
      ({ source, cut }, doc) => {
        const id = nextLayerId(doc);
        current.apply("Cut", (d) => cutLayer(d, source.id, cut));
        current.clearRegion();
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
        current.apply("Paste image", (d) => addRasterLayer(d, image, "Pasted image", centeredPlacement(d, image)));
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

  // ---- Effects (SPM-8) ----

  /**
   * What the preview should show now: the active effect tool's settings on
   * its target layer in the current document, or nothing. Called on every
   * refresh, so switching tool or layer, undo/redo and any edit discard an
   * unapplied preview and draw a fresh one if the tool is still active
   * (CMT-185, CMT-186); it never enters the document or its history.
   */
  function previewRequest(): PreviewRequest | null {
    const kind = effectKindOf(tool);
    if (!session || !kind) return null;
    const target = effectTarget(session.doc, session.selection);
    return "id" in target ? { doc: session.doc, layerId: target.id, effect: effectControls.effect(kind) } : null;
  }

  /**
   * The Outline tool's preview and Apply on a text layer (SPM-18): the
   * style it sets, the Rust render of it, and the transform the model's
   * setTextStyle will land for that render (anchoredTransform) — the one
   * place both callers share, so the preview IS the result. Apply commits
   * style + render and lets setTextStyle do its own anchoring; the
   * transform here is what the preview override shows.
   */
  async function outlinedTextRender(text: TextLayer, outline: OutlineStyle): Promise<{ style: TextStyle; render: TextRender; transform: Transform }> {
    const style: TextStyle = { ...textStyleOf(text), outline };
    const render = await renderText(style);
    return { style, render, transform: anchoredTransform(text.transform, text.render.metrics, render.metrics) };
  }

  /**
   * Apply (CMT-183): bake the previewed effect into the layer's pixels as
   * ONE undo step: the very result the preview shows (or, when the settings
   * just changed, the one being drawn). The Move tool comes back, as after
   * Cut. Since SPM-18, Outline on a TEXT layer commits a STYLE change
   * instead: the layer keeps its text and its place, one undo step, no
   * conversion note — only Glow on text still bakes pixels.
   */
  async function applyEffectTool(): Promise<void> {
    const current = session;
    const kind = effectKindOf(tool);
    const req = previewRequest();
    if (!current || !kind || !req) return;
    const layer = req.doc.layers[layerIndex(req.doc, req.layerId)];
    // The Outline tool on a text layer (SPM-18): the same render the
    // preview showed, committed as the layer's outline style.
    if (outlineTextPatch(req.effect, layer)) {
      await editAsync(
        current,
        { doing: "drawing the outline", done: "applied" },
        async (doc) => {
          const live = doc.layers[layerIndex(doc, req.layerId)];
          const patch = outlineTextPatch(req.effect, live);
          if (!patch) return null; // it stopped being a text layer under the snapshot
          return await outlinedTextRender(patch.layer, patch.outline);
        },
        ({ style, render }) => {
          setTool("move"); // drops the preview first: the styled text replaces it
          current.apply("Outline", (d) => setTextStyle(d, req.layerId, style, render));
        },
      );
      return;
    }
    await editAsync(
      current,
      { doing: `drawing the ${kind}`, done: "applied" },
      () => preview.result(req),
      (result) => {
        setTool("move"); // drops the preview first: the baked pixels replace it
        current.apply(kind === "glow" ? "Glow" : "Outline", (d) => applyEffectResult(d, req.layerId, result));
        const notice = effectTextNotice(layer, kind);
        if (notice) say(notice, "note");
      },
    );
  }

  /**
   * A warp press starts (SPM-8, CMT-243): ONE bulge at the press point,
   * painted live into a copy of the target layer. Nothing is painted until
   * it is clear what the press is: a drag grows the bulge from the pointer's
   * distance (so it never jumps from the bar's size), a click gets the bar's
   * values on release.
   */
  function beginWarp(at: Point, shift: boolean): void {
    const current = session;
    if (!current || !stage || busy || warp) return;
    const target = warpTarget(current.doc, current.selection);
    if ("blocker" in target) {
      say(target.blocker);
      return;
    }
    const layer = current.doc.layers[layerIndex(current.doc, target.id)];
    if (layer.kind !== "raster") return; // narrows the type: warpTarget already refused text
    say("");
    warp = { press: new WarpPress(layer), gesture: startWarpGesture(at, effectControls.warp, shift) };
    stage.setOverride({ id: layer.id, image: warp.press.canvas, transform: layer.transform });
  }

  /** The pointer moved during a warp press: a drag sets the radius, or with Shift the strength. */
  function continueWarp(at: Point, shift: boolean): void {
    if (!warp || !stage) return;
    const before = warp.gesture;
    const g = moveWarpGesture(before, at, shift, stage.view().scale);
    warp.gesture = g;
    if (!g.dragged) return;
    stage.setBrushGesture({ center: g.center, radius: g.radius, readout: warpReadout(g) });
    if (!before.dragged || g.radius !== before.radius || g.strength !== before.strength) {
      warp.press.place(g.center, g.radius, g.strength);
      stage.redraw();
    }
  }

  /** A warp press ends: its pixels become the layer's as ONE undo step (CMT-148). */
  function endWarp(): void {
    const finished = warp;
    warp = null;
    const current = session;
    if (!finished || !current) return;
    stage?.setOverride(null);
    stage?.setBrushGesture(null);
    const { press, gesture: g } = finished;
    if (g.dragged) effectControls.setWarp({ radius: g.radius, strength: g.strength }); // for the next click
    else press.place(g.center, g.radius, g.strength); // a click: the bar's values
    const image = press.finish();
    const layer = press.layer;
    // The target layer changed mid-press (e.g. Ctrl+Z): the bulge was painted on old pixels, so it is dropped.
    const stale = current.doc.layers.find((l) => l.id === layer.id) !== layer;
    if (image && stale) say("The layers changed while warping; the bulge was dropped. Try again.");
    if (image && !stale) current.apply("Warp", (d) => setLayerImage(d, layer.id, image));
    else refresh(); // no new state to redraw from, but the bar's values may have changed
  }

  // ---- Magic wand (SPM-22): a click selects colour-similar pixels ----

  /** The wand press in progress, if any: what it selects from, and its drag. */
  let wand: WandPress | null = null;

  /**
   * Merge a floating selection's contributions over the document (SPM-23):
   * the dashed outline's source, in document pixels; null when the stack
   * covers nothing (a subtract that emptied it).
   */
  async function mergedSelection(current: EditorSession, contributions: readonly Contribution[]): Promise<ComposedRegion | null> {
    const merged = await composeSelection(current.doc.width, current.doc.height, IDENTITY, contributions);
    return merged.width === 0 || merged.height === 0
      ? null
      : { kind: "compose", contributions, outlines: traceOutlines(merged, IDENTITY) };
  }

  /**
   * A Rectangle/Lasso draw released with Shift or Alt over an existing
   * selection (SPM-23): the polygon joins the selection's stack, which is
   * merged again over the document for its dashed outline, as one step.
   * An emptied stack is a step to none, so the step-undo restores it.
   */
  function composeShape(op: ContributionOp, points: readonly Point[]): void {
    const current = session;
    if (!current || busy) return;
    const region = current.region;
    if (!region) return; // the stage only composes onto a selection already drawn
    const contribution: PolyContribution = {
      kind: "poly",
      op,
      feather: feathered,
      points,
      // The active tool names the step in the Actions list (SPM-15): the
      // polygon alone cannot tell a lasso from a rectangle.
      shape: tool === "rect" ? "rectangle" : "lasso",
    };
    const contributions = [...contributionsOf(region, feathered), contribution];
    void run(async () => current.commitRegion(await mergedSelection(current, contributions)));
  }

  /**
   * A wand press begins (owner decisions 2026-11-24; composed across tools
   * since SPM-23): the target follows the effects tools (the selected image
   * layer, else the base image) and becomes the layer selection, so Cut and
   * Delete act on what the click selected. A plain click replaces the
   * selection; with a selection drawn, Shift adds the clicked region to it
   * and Alt subtracts it — whatever tool or layer built it. With no
   * selection on the canvas every modifier acts as a plain click.
   */
  function beginWand(at: Point, mods: { shift: boolean; alt: boolean }): void {
    const current = session;
    if (!current || !stage || busy || wand) return;
    const target = backgroundTarget(current.doc, current.selection);
    if ("reason" in target) {
      say(target.reason);
      return;
    }
    const layer = target.layer;
    const local = docToLocal(layer.transform, at);
    if (local.x < 0 || local.y < 0 || local.x >= layer.image.width || local.y >= layer.image.height) {
      say(NOTHING_TO_SELECT_OUTSIDE);
      return;
    }
    const base = ((local.y | 0) * layer.image.width + (local.x | 0)) * 4;
    if (layer.image.pixels[base + 3] === 0) {
      say(NOTHING_TO_SELECT_TRANSPARENT);
      return;
    }
    const region = current.region;
    const mode = wandCommitMode(region, mods);
    if (current.selection.length !== 1 || current.selection[0] !== layer.id) current.select(layer.id);
    say("");
    wand = {
      layerId: layer.id,
      image: layer.image,
      transform: layer.transform,
      mode,
      base: region ? contributionsOf(region, feathered) : [],
      gesture: startWandGesture(at, tolerance),
      filled: tolerance,
      stepped: undefined,
      fills: 0,
    };
    void fillWand(wand, tolerance);
  }

  /** The pointer moved during a wand press: a drag sets the tolerance, and the layer re-fills per step. */
  function continueWand(at: Point): void {
    const press = wand;
    if (!press || !stage) return;
    const before = press.gesture;
    const g = moveWandGesture(before, at, stage.view().scale);
    press.gesture = g;
    if (!g.dragged) return;
    stage.setWandReadout(wandReadout(g));
    // Each re-fill round-trips the layer's pixels, so a drag pays a handful
    // of fills (one per step), not one per integer of tolerance.
    if (g.tolerance !== before.tolerance && refillStepOf(g.tolerance) !== refillStepOf(before.tolerance)) {
      void fillWand(press, g.tolerance);
    }
  }

  /** A wand press ends: the drag's tolerance becomes the bar's value. */
  function endWand(): void {
    const finished = wand;
    wand = null;
    stage?.setWandReadout(null);
    if (!finished) return;
    const g = finished.gesture;
    if (!g.dragged) return;
    tolerance = g.tolerance;
    if (document.activeElement !== toleranceInput) toleranceInput.value = String(g.tolerance);
    if (g.tolerance !== finished.filled) void fillWand(finished, g.tolerance);
  }

  /**
   * Fill from the press's clicked spot at `tolerance` and commit what its
   * mode leaves (SPM-23): a replacing click stores its fill as a
   * one-contribution floating selection (today's own mask, no merge round
   * trip); an adding or subtracting click appends the live fill to the
   * press's snapshot and merges the stack over the document. The last fill
   * wins (a drag may request several), and a fill whose target's pixels
   * changed underneath is dropped.
   */
  async function fillWand(press: WandPress, atTolerance: number): Promise<void> {
    const id = ++press.fills;
    try {
      const mask = await wandSelect(press.image, press.transform, press.gesture.seed, atTolerance, feathered);
      if (press.fills !== id) return; // a newer fill superseded this one
      press.filled = atTolerance;
      const current = session;
      const layer = current?.doc.layers.find((l) => l.id === press.layerId);
      if (!current || !layer || layer.kind !== "raster" || layer.image !== press.image) {
        say("The layers changed while selecting; nothing was selected. Try again.");
        return;
      }
      const fill: WandContribution = { kind: "wand", op: "add", transform: press.transform, mask };
      // The press's FIRST landed fill is one selection step (pushing the
      // pre-press selection); every refill amends that same step, so a
      // tolerance drag is one step, not one per refill (SPM-23, owner
      // decision 2026-11-24). A fill that never landed leaves no step, and a
      // step that died mid-drag (Esc, a document change) is not amended: the
      // next fill is a fresh step.
      const amend = press.stepped !== undefined && current.region === press.stepped;
      if (press.mode === "replace") {
        const region: ComposedRegion = { kind: "compose", contributions: [fill], outlines: traceOutlines(mask, press.transform) };
        if (amend) current.amendRegion(region);
        else current.commitRegion(region);
        press.stepped = region;
        return;
      }
      const contributions: Contribution[] = [...press.base, { ...fill, op: press.mode }];
      const region = await mergedSelection(current, contributions);
      if (press.fills !== id) return; // a newer fill superseded this one mid-merge
      if (amend) current.amendRegion(region);
      else current.commitRegion(region);
      press.stepped = region;
    } catch (error) {
      say(errorMessage(error));
    }
  }

  // ---- Background removal (SPM-7, ADR-0006) ----

  /**
   * Remove background: Rust runs the model on the target layer (the selected
   * image layer, or the base image) and the result is ONE undo step that
   * keeps the original pixels for the Restore brush. The first use downloads
   * the model, after asking. Notes show progress in the neutral tone; any
   * failure replaces them in the error tone.
   */
  async function removeBackground(): Promise<void> {
    const current = session;
    if (!current || "reason" in backgroundTarget(current.doc, current.selection)) return;
    try {
      if (!(await ensureBackgroundModel())) return;
      say("Removing the background…", "note");
      await editAsync(
        current,
        { doing: "removing the background", done: "changed" },
        async (doc) => {
          const target = backgroundTarget(doc, current.selection);
          if ("reason" in target) throw new Error(target.reason);
          return { id: target.layer.id, image: await removeImageBackground(target.layer.image) };
        },
        ({ id, image }) => {
          current.apply("Remove background", (d) => refineLayerPixels(d, id, image));
          say("");
        },
      );
    } catch (err) {
      // withMessage would keep the neutral note tone set by "Removing the background…", so say errors again in the error tone.
      say(errorMessage(err));
    }
  }

  /**
   * True when the model is ready: already cached, or downloaded now after
   * the user agreed. Cancel in the dialog, or Cancel download, leaves it be.
   */
  async function ensureBackgroundModel(): Promise<boolean> {
    const status = await backgroundModelStatus();
    if (status.downloaded) return true;
    if (!(await confirmModelDownload(status.sizeBytes))) return false;
    // One report drives both the message line and the disabled Save's tooltip
    // (SPEC §6, §2: a disabled control shows its reason). Direct assignments
    // rather than refresh(): a progress tick is too frequent for a full pass.
    function reportProgress(p: DownloadProgress): void {
      downloadNote = downloadProgressText(p);
      say(downloadNote, "note");
      saveButton.title = blockedTitle(saveStem, downloadNote, saveTitle());
    }
    reportProgress({ received: 0, total: status.sizeBytes });
    // Progress reports travel apart from the command's reply: one arriving
    // after it must not bring the button or the progress note back.
    let active = true;
    try {
      // Cancel download appears with Rust's first report, sent once the
      // download has begun (and its cancel flag is cleared), so a press is never lost.
      const outcome = await downloadBackgroundModel((p) => {
        if (!active) return;
        cancelDownloadButton.hidden = false;
        reportProgress(p);
      });
      if (outcome === "cancelled") {
        say("The model download was cancelled.", "note");
        return false;
      }
      return true;
    } finally {
      active = false;
      downloadNote = null;
      cancelDownloadButton.hidden = true;
      // The model's inference wait is a generic busy action: Save shows its
      // canvas reason again (or its normal title) until run()'s closing refresh().
      const saveReason = session ? saveBlocker(session.doc, constraints) : null;
      saveButton.title = blockedTitle(saveStem, saveReason, saveTitle());
    }
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
    // Opening text editing surfaces Text even though the pointer tool stays
    // Move (SPEC §6 Layout): the panel follows the active editing surface.
    // Closing the overlay puts it back wherever the tool actually is.
    showPanel("text");
    const panelAfterEdit = (): void => showPanel(TOOL_PANEL[tool]);
    if (layer) {
      current.select(layer.id);
      stage.setEditing(layer.id);
    }
    overlayLayerId = layer ? layer.id : null;
    const placement = textOverlayPlacement(stage.view(), layer ?? null, current.doc);
    textOverlay.open(
      {
        // The overlay styles what DOM text can render: family, size, line
        // metrics, colour. The outline (SPM-18) is a Rust stroke on the
        // glyph outlines, so it shows on the committed canvas render, not
        // while typing — the same approximation class as the overlay's
        // fallback fonts (ADR-0005's SPM-20 amendment).
        text: style.text,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        color: style.color,
        lineHeight: layer ? layer.render.metrics.lineHeight : null,
        placement,
      },
      {
        commit: (text) => {
          stage?.setEditing(null);
          panelAfterEdit();
          if (isBlankText(text) || text === style.text) return;
          void run(() => (layer ? restyleLayers([layer.id], { text }) : addText({ ...style, text })));
        },
        cancel: () => {
          stage?.setEditing(null);
          panelAfterEdit();
        },
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
        current.apply("Add text", (d) => addTextLayer(d, style, render, centeredPlacement(d, render.image)));
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
      (changes) => current.apply("Restyle text", (d) => setTextStyles(d, changes)),
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
   * canvas as one group, measured like a multi-layer selection. One undo
   * step. `label` is the action's name for the Actions panel (SPM-15), the
   * top row's own words: "Fit in 512", "Cover 100", "Free resize".
   */
  function resizeWholeImage(label: string, tool: (doc: Doc, content: Rect) => Doc): void {
    const current = session;
    if (!current || !stage || busy) return;
    const content = stage.contentBounds();
    say("");
    try {
      current.apply(label, (doc) => tool(doc, content));
    } catch (err) {
      say(errorMessage(err));
    }
  }

  /** The free-resize field as a number; NaN when empty (so the shared rule rejects it). */
  function enteredSide(): number {
    return sideInput.value.trim() === "" ? NaN : Number(sideInput.value);
  }

  /** Sizing tool 3 (SPEC §6): free resize, the entered value is the chosen `freeSide`; the canvas stays. */
  function freeResize(): void {
    const side = enteredSide();
    const problem = resizeSideProblem(side, freeSide);
    if (problem) {
      say(problem);
      return;
    }
    resizeWholeImage("Free resize", (doc, content) => resizeToSide(doc, content, side, freeSide));
  }

  /** Why Delete cannot run right now: with a region drawn it erases, else it deletes layers. */
  function deleteReasonOf(current: EditorSession): string | null {
    return current.region
      ? eraseBlocker(current.doc, current.selection, current.region)
      : deleteBlocker(current.doc, current.selection);
  }

  /** Delete the selected layers as one undoable step (SPEC §6); one layer always stays. */
  function deleteSelected(): void {
    const current = session;
    if (!current || busy || deleteBlocker(current.doc, current.selection)) return;
    const chosen = [...current.selection];
    current.apply("Delete layers", (doc) => deleteLayers(doc, chosen));
  }

  /**
   * Delete (owner decision 2026-11-24): with a selection drawn it erases
   * the selection's pixels from the layer it belongs to, as ONE undo step
   * that keeps the layer's restore source (Restore brings them back); with
   * none drawn it deletes the selected layers.
   */
  function deletePressed(): void {
    const current = session;
    if (!current) return;
    if (!current.region) return deleteSelected();
    const reason = deleteReasonOf(current);
    if (reason) {
      say(reason);
      return;
    }
    void run(eraseSelection);
  }

  /**
   * Erase the drawn selection's pixels in Rust (SPM-22, composed since
   * SPM-23): a floating selection merges into the one selected image layer's
   * own grid first (a wand fill used where it was drawn, a polygon
   * rasterised like a plain one's) and erases from its coverage, while a
   * plain Rectangle/Lasso erases its whole pixels. One undo step; the
   * layer's restore source is kept, so Restore brings the pixels back.
   */
  async function eraseSelection(): Promise<void> {
    const current = session;
    if (!current) return;
    const region = current.region;
    if (!region) return;
    await editAsync(
      current,
      { doing: "erasing", done: "erased" },
      async (doc) => {
        const source = doc.layers[layerIndex(doc, current.selection[0])];
        if (source.kind !== "raster") return null;
        return { id: source.id, hole: await eraseFor(source, region) };
      },
      ({ id, hole }) => {
        current.apply("Erase selection", (d) => refineLayerPixels(d, id, hole));
        current.clearRegion();
      },
    );
  }

  /**
   * The hole a selection leaves in one raster layer (SPM-22, composed since
   * SPM-23): a floating selection merges into the layer's own grid first and
   * each covered pixel keeps the uncovered share of its alpha; a plain
   * Rectangle/Lasso erases its whole pixels, exactly what Cut's hole leaves.
   */
  async function eraseFor(source: RasterLayer, region: Region): Promise<RgbaImage> {
    if (region.kind !== "compose") return eraseRegion(source.image, source.transform, region.points);
    return eraseMask(source.image, source.transform, await composeMaskFor(source, region, NOTHING_TO_ERASE));
  }

  function moveSelected(step: number): void {
    const current = session;
    if (!current || current.selection.length !== 1) return;
    const id = current.selection[0];
    current.apply(step > 0 ? "Move layer up" : "Move layer down", (doc) => {
      const index = layerIndex(doc, id);
      const target = index + step;
      return target < 0 || target >= doc.layers.length ? doc : moveLayer(doc, id, target);
    });
  }

  function renderLayers(current: EditorSession): void {
    const doc = current.doc;
    // The single selected layer's current size, live (CMT-152); null with
    // no or several layers selected, so nothing is appended.
    const size = selectedLayerSize(doc, current.selection);
    layersList.replaceChildren(
      // Top of the stack first, as layer panels read.
      ...[...doc.layers].reverse().map((layer) => {
        const item = el(
          "li",
          { class: current.selection.includes(layer.id) ? "selected" : "" },
          el("span", { class: "editor-layer-kind" }, layer.kind === "raster" ? "Image" : "Text"),
          el("span", { class: "editor-layer-name" }, layer.name),
        );
        // No muted colour here: the span lives only on the selected row, whose
        // accent background drops --muted below any readable contrast (owner,
        // from the test, 2026-11-23); it inherits the row's full-contrast text
        // like the kind label at full opacity.
        if (size && layer.id === current.selection[0]) {
          item.append(el("span", { class: "editor-layer-size" }, size));
        }
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
    // The tools panel is part of the workspace: gone with no session, like it.
    toolsPanel.hidden = current === null;
    // The right panel too: Layers, Actions and Emoji all describe a session.
    layersPanel.hidden = current === null;
    // The status strip describes a session's canvas and view, so it goes with them.
    statusStrip.hidden = current === null;
    openButton.disabled = busy;
    // The canvas tool buttons follow `tool` with or without a session, so
    // after Close no button stays pressed on the hidden top row or in the
    // tools panel (SPM-8); the panel's effect blocks hide too (no session
    // leaves their DOM in place).
    for (const [b, t] of [
      [moveToolButton, "move"],
      [rectToolButton, "rect"],
      [lassoToolButton, "lasso"],
      [wandToolButton, "wand"],
      [outlineToolButton, "outline"],
      [glowToolButton, "glow"],
      [warpToolButton, "warp"],
      [eraseToolButton, "erase"],
      [restoreToolButton, "restore"],
    ] as const) {
      b.setAttribute("aria-pressed", String(tool === t));
      b.disabled = busy;
    }
    if (!current) {
      layersList.replaceChildren();
      actionsList.replaceChildren();
      effectControls.hide();
      return;
    }
    // A discard (another target picked, undo/redo, any edit) ends the Outline/Glow tool.
    if (basis) {
      const next = nextEffectBasis(basis, current.doc, current.selection);
      if (next === "discard") {
        setTool("move"); // refreshes again, with the Move tool
        return;
      }
      basis = next;
    }
    renderLayers(current);
    // The right panel's tab set (SPEC §6 Layout): the Emoji leaf hides in
    // Thumbnail mode, recomputed on EVERY refresh from the session's mode —
    // the view is built once and cached, so a Thumbnail session handing off
    // to a Sticker session must bring the leaf back (owner's live-test
    // note). The panel goes back to Layers whenever the set changes.
    const emojiHidden = constraints.mode === "thumbnail";
    if (emojiHidden !== emojiLeafHidden) {
      emojiLeafHidden = emojiHidden;
      rightTabs.buttons.emoji.hidden = emojiHidden;
      showRightTab("layers");
    }
    // The Actions tab: the document trail and the live selection trail,
    // rendered read-only on every change (SPM-15 D3).
    renderActionList(actionsList, actionList(current.actionTrail(), current.selectionTrail()));
    // The Emoji tab: what the session's box holds now. A blocked box (a gone
    // or other-Library origin) stays visible, disabled with its reason as
    // the tooltip (§2). The typed text wins while the box has focus.
    const emojiBox = emoji;
    const emojiBlock = emojiBox?.blocked ?? null;
    emojiInput.disabled = busy || emojiBox === null || emojiBlock !== null;
    emojiInput.title = emojiBlock?.message
      ? `Emoji String — ${emojiBlock.message}`
      : "Emoji String — Enter or leaving the box commits it; 1–20 emoji (a warning shows past 20), empty allowed";
    if (emojiBox && document.activeElement !== emojiInput) emojiInput.value = emojiBox.value;
    const doc = current.doc;
    // The toolbar's mode-dependent labels (SPEC §6): the sizing tools take
    // their side from the active constraint set, and Save's idle title says
    // what saving does in this mode. The mode never changes mid-session, so
    // this is stable across refreshes.
    const side = constraints.side;
    const fitName = `Fit in ${side}`;
    const fillName = `Cover ${side}`;
    const longestName = `Long side ${side}`;
    fitButton.textContent = fitName;
    fillButton.textContent = fillName;
    longestButton.textContent = longestName;
    const sideLabel = freeSide === "longest" ? "Long" : "Short";
    sideInput.setAttribute("aria-label", `${sideLabel} side in pixels`);
    sideInput.title = `${sideLabel} side — The entered size in pixels (1–${IMPORT_MAX_SIDE})`;
    const fitTitle =
      `${fitName} — Scale everything on the canvas together, as one image, so its longest side is ${side} px; ` +
      `the canvas becomes ${side}×${side} with transparent padding`;
    const fillTitle =
      `${fillName} — Scale everything on the canvas together, as one image, so its shortest side is ${side} px; ` +
      `the canvas becomes ${side}×${side} and anything beyond it is kept (drag the image to choose what shows)`;
    const longestTitle =
      `${longestName} — Scale everything on the canvas together so its longest side is ${side} px; ` +
      "the canvas becomes the image (no padding)";
    const single = current.selection.length === 1 ? current.selection[0] : null;
    const index = single ? layerIndex(doc, single) : -1;
    const blocker = mergeBlocker(current.selection);
    // With a selection drawn Delete erases its pixels; with none it deletes
    // the selected layers (owner decision 2026-11-24).
    const deleteReason = deleteReasonOf(current);
    addButton.disabled = busy;
    // Each sizing tool is disabled when it would change nothing or, for Longest
    // side, when the set needs a square canvas (SPEC §6).
    const content = stage ? stage.contentBounds() : null;
    const entered = enteredSide();
    const sizing: { button: HTMLButtonElement; tool: SizeTool; name: string; action: string }[] = [
      { button: fitButton, tool: "fit", name: fitName, action: fitTitle },
      { button: fillButton, tool: "fill", name: fillName, action: fillTitle },
      { button: longestButton, tool: "longest", name: longestName, action: longestTitle },
      { button: resizeButton, tool: "free", name: "Resize", action: resizeTitle() },
    ];
    for (const { button, tool, name, action } of sizing) {
      const reason = sizeToolBlocker(tool, doc, content, entered, constraints, freeSide);
      button.disabled = busy || reason !== null;
      // A disabled control's blocker replaces the description, never the name (SPEC §2).
      button.title = blockedTitle(name, reason, action);
    }
    sideInput.disabled = busy;
    sideKind.disabled = busy;
    // One cropState result drives the overlay, the label and the blocker;
    // cropToBox() reads the same function.
    const { box, blocker: cropReason } = cropState(doc);
    stage?.setCropBox(box);
    const boxSize = `${box.width}×${box.height}`;
    const cropName = `Crop to ${boxSize}`;
    cropButton.textContent = cropName;
    cropButton.disabled = busy || cropReason !== null;
    cropButton.title = cropReason !== null ? `${cropName} — ${cropReason}` : cropTitle(boxSize);
    boxButton.setAttribute("aria-pressed", String(showBox));
    const status = readoutStatus(doc, constraints);
    readout.textContent = status.text;
    readout.classList.toggle("off", !status.ok);
    resetViewButton.disabled = busy;
    closeButton.disabled = busy;
    const saveReason = saveBlocker(doc, constraints);
    saveButton.disabled = busy || saveReason !== null;
    // While the model downloads (the one long busy wait), the disabled Save
    // says the download's progress instead of its idle title (SPEC §2).
    saveButton.title = blockedTitle(saveStem, saveReason ?? downloadNote, saveTitle());
    undoButton.disabled = busy || !current.canUndoAny;
    undoButton.title = blockedTitle(
      "Undo (Ctrl+Z)",
      current.canUndoAny ? null : "Nothing to step back to yet",
      undoTitle,
    );
    redoButton.disabled = busy || !current.canRedoAny;
    redoButton.title = blockedTitle(
      "Redo (Ctrl+Y)",
      current.canRedoAny ? null : "Nothing to step forward to yet",
      redoTitle,
    );
    // The stack's ends and the one-layer rule are the two blockers here
    // (SPEC §2): each disabled arrow says which one is in the way.
    const atTop = index === doc.layers.length - 1;
    upButton.disabled = busy || !single || atTop;
    upButton.title = blockedTitle(
      "Move up",
      !single ? "Select one layer to move it" : atTop ? "The layer is already at the top" : null,
      upTitle,
    );
    downButton.disabled = busy || !single || index === 0;
    downButton.title = blockedTitle(
      "Move down",
      !single ? "Select one layer to move it" : index === 0 ? "The layer is already at the bottom" : null,
      downTitle,
    );
    mergeButton.disabled = busy || blocker !== null;
    mergeButton.title =
      blocker !== null ? `Merge selected — ${blocker}` : "Merge selected — Merge the selected layers into one";
    deleteButton.disabled = busy || deleteReason !== null;
    const deleteTitle = current.region
      ? "Delete (Delete key) — Erase the selection's pixels"
      : "Delete (Delete key) — Remove the selected layers";
    deleteButton.title = blockedTitle("Delete (Delete key)", deleteReason, deleteTitle);
    const cutReason = cutBlocker(doc, current.selection, current.region);
    cutButton.disabled = busy || cutReason !== null;
    cutButton.title = cutReason !== null ? `Cut (Ctrl+X) — ${cutReason}` : cutTitle;
    pasteButton.disabled = busy;
    pasteButton.title = pasteTitle;
    // Background removal (SPM-7); the brushes say why on a press instead.
    const bgTarget = backgroundTarget(doc, current.selection);
    const removeReason = "reason" in bgTarget ? bgTarget.reason : null;
    removeBackgroundButton.disabled = busy || removeReason !== null;
    removeBackgroundButton.title =
      removeReason !== null ? `Remove background — ${removeReason}` : removeBackgroundTitle;
    brushSizeInput.disabled = busy;
    toleranceInput.disabled = busy;
    featherInput.disabled = busy;
    // Text tool (SPM-9): the controls show the first selected text layer's
    // style, else the next new text's.
    const texts = current.selectedTexts;
    const shown = texts.length > 0 ? textStyleOf(texts[0]) : nextStyle;
    const textReason = textBlocker(fonts, fontsProblem);
    textButton.disabled = busy || textReason !== null;
    textButton.title = textReason !== null ? `Add text — ${textReason}` : textTitle;
    const editReason = editTextBlocker(textReason, doc, current.selection);
    editTextButton.disabled = busy || editReason !== null;
    editTextButton.title = editReason !== null ? `Edit text — ${editReason}` : editTextTitle;
    // The picker lists the installed fonts, plus a layer's font that is no longer installed.
    const choices = fontChoices(fonts ?? [], shown.fontFamily);
    fontPicker.setFonts(choices);
    fontPicker.value = shown.fontFamily;
    if (document.activeElement !== fontSizeInput) fontSizeInput.value = String(shown.fontSize);
    colorInput.value = shown.color;
    // The outline controls (SPM-18): width 0 stands for the style's null.
    if (document.activeElement !== outlineWidthInput) outlineWidthInput.value = String(shown.outline?.width ?? 0);
    outlineColorInput.value = shown.outline?.color ?? DEFAULT_OUTLINE_COLOR;
    for (const control of textControls) control.disabled = busy || textReason !== null;
    const target = texts.length > 0 ? "the selected text" : "the next text";
    fontPicker.title = textReason !== null ? `Font — ${textReason}` : `Font — The font of ${target}`;
    fontSizeInput.title =
      textReason !== null
        ? `Font size — ${textReason}`
        : `Font size — The size of ${target} in px (${TEXT_FONT_SIZE.min}–${TEXT_FONT_SIZE.max})`;
    colorInput.title = textReason !== null ? `Text colour — ${textReason}` : `Text colour — The colour of ${target}`;
    outlineColorInput.title =
      textReason !== null ? `Text outline colour — ${textReason}` : `Text outline colour — The outline colour of ${target}`;
    outlineWidthInput.title =
      textReason !== null
        ? `Text outline width — ${textReason}`
        : `Text outline width — The outline width of ${target} in px (0 for no outline)`;
    // The two eyedroppers join the text controls' disable loop, so a disabled
    // one says the same fonts blocker (SPEC §2).
    textEyedropper.title = blockedTitle("Eyedropper", textReason, EYEDROPPER_TITLE);
    outlineEyedropper.title = blockedTitle("Eyedropper", textReason, EYEDROPPER_TITLE);
    // Explain disabled actions only once something is selected.
    layerHint.textContent = layerHintText(doc, current.selection, current.region, {
      merge: blocker,
      delete: deleteReason,
      cut: cutReason,
      editText: editReason,
    });
    dirtyLabel.hidden = !current.isDirty;
    // Effect tools (SPM-8): the bar, the brush ring and the live preview follow the current state.
    const effectOn = tool === "warp" ? warpTarget(doc, current.selection) : effectTarget(doc, current.selection);
    const effectLayer = "id" in effectOn ? doc.layers[layerIndex(doc, effectOn.id)] : null;
    effectControls.update({
      tool,
      busy,
      targetName: "id" in effectOn ? layerLabel(doc, effectOn.id, current.selection) : null,
      blocker: "blocker" in effectOn ? effectOn.blocker : null,
      // The bar's Apply says what it does on a text layer (SPM-18): Outline
      // restyles it, Glow converts it.
      textTarget: effectLayer?.kind === "text",
    });
    stage?.setBrushRadius(effectControls.warp.radius);
    preview.request(previewRequest());
  }

  /** A target layer's name, saying when it is the base image by default. */
  function layerLabel(doc: Doc, id: string, selection: readonly string[]): string {
    const name = doc.layers[layerIndex(doc, id)].name;
    return selection.length === 0 ? `${name} (base image)` : name;
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
    if (!current || !view.isConnected) return;
    // A bare Alt is marked handled while a session is open (owner re-test
    // ruling 2026-11-24, SPM-23): on Windows it is the system menu's toggle,
    // and while the menu holds the input the wheel never reaches the canvas,
    // so each Alt press flipped zoom on and off. Only the default is
    // suppressed; no behaviour is attached. AltGr is safe: its events carry
    // the character as their key, not "Alt", and a text field keeps the
    // default (AltGr types there).
    if (e.key === "Alt" && !isTextTarget(e.target)) e.preventDefault();
    if (textOverlay.isOpen) return;
    // While the toolbar is busy, Ctrl+S still says why (SPEC §6): the model
    // download is the one wait long enough to need it; other keys wait too.
    if (busy) {
      if (isSaveShortcut(e) && downloadNote) say(downloadNote, "note");
      return;
    }
    if (isTextTarget(e.target)) return;
    // A colour pick in progress takes Esc first (SPM-8, CMT-296), then a
    // lasso in progress takes Enter, Esc and Backspace (SPM-9) - the most
    // recent mode cancels first - and only then the Editor's own Esc runs.
    if (stage?.handlePickKey(e.key) || stage?.handleLassoKey(e.key, { shift: e.shiftKey, alt: e.altKey })) {
      e.preventDefault();
      return;
    }
    // The single-key tool shortcuts (SPEC §6 Layout): the table and matcher
    // are src/editor/model/shortcuts.ts; this caller owns the guards above
    // (no session, overlay open, busy, a text field has focus). Each tool
    // activation runs the button's own path, so it surfaces its category;
    // T is the Text category's switch, not a tool.
    const shortcut = shortcutOf(e);
    if (shortcut) {
      if (shortcut === "text-tab") showPanel("text");
      else setTool(shortcut);
      e.preventDefault();
      return;
    }
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) {
      clearNote();
      current.undoSelectionFirst();
    }
    else if ((e.ctrlKey || e.metaKey) && (key === "y" || (key === "z" && e.shiftKey))) {
      clearNote();
      current.redoSelectionFirst();
    }
    // Ctrl+S saves; a blocked save says why (SPEC §6: hard-blocked), and a
    // mid-press brush stroke is refused before the dialog can open.
    else if (isSaveShortcut(e)) {
      const reason = saveRefusal(stage?.strokeInProgress() ?? false, current.doc, constraints);
      if (reason) say(reason);
      else void run(saveSession);
    }
    // Ctrl+X is the Cut tool, not the clipboard; a blocked cut says why.
    else if (isCutShortcut(e)) {
      const reason = cutBlocker(current.doc, current.selection, current.region);
      if (reason) say(reason);
      else void run(cutSelection);
    }
    // Esc drops the cut selection first, then the layer selection. In
    // Outline and Glow an Esc that deselects is a discard (CMT-243, restored
    // by the owner 2026-11-23): back to Move whatever layer was selected,
    // the base image included — nextEffectBasis's re-pick shortcut must not
    // swallow it. Esc with nothing selected does nothing (the tool and its
    // preview stay), and Warp/Erase/Restore keep today's Esc.
    else if (e.key === "Escape") {
      if (escapeTarget(current.region) === "region") current.clearRegion();
      else if (escDiscardsEffect(tool, current.selection)) {
        setTool("move"); // first, so the clearSelection's refresh finds no basis to re-decide
        current.clearSelection();
      } else current.clearSelection();
    }
    else if (e.key === "Delete") deletePressed();
    else return;
    e.preventDefault();
  });

  // The Windows system menu triggers on Alt's RELEASE, so the keyup is
  // marked handled too (owner re-test ruling 2026-11-24, SPM-23). With no
  // session open the Editor leaves Alt alone, as it leaves every shortcut.
  document.addEventListener("keyup", (e) => {
    if (!session || !view.isConnected) return;
    if (e.key === "Alt" && !isTextTarget(e.target)) e.preventDefault();
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
      // Both questions go through closeSession: unsaved changes first, and
      // the gone-origin one for a clean session (owner decision 2026-11-23).
      const closed = await closeSession();
      showEditor(); // either way: Keep editing shows the open image
      if (closed) await openImage(path, from ?? null);
    });
  // The thumbnail slot's hook (SPM-12): the same questions, then Thumbnail mode.
  openThumbnailHook = (path, showEditor, from) =>
    run(async () => {
      const closed = await closeSession();
      showEditor();
      if (closed) await openThumbnail(path, from);
    });
  // The dialog then says why Replace is gone, rather than silently dropping it.
  forgetOriginHook = () => {
    if (origin) origin = { ...origin, otherLibrary: true };
    // A thumbnail session's pack id is just as old: its save says so too.
    if (thumbnailOrigin) thumbnailOrigin = { ...thumbnailOrigin, otherLibrary: true };
    // The Emoji tab's sticker id is old too: never look it up in the new Library (SPM-15).
    emoji?.forgetOrigin();
    libraryGeneration++; // a saved note's link now points into the old Library
    refresh(); // the Emoji box shows its disabled reason at once
  };

  refresh();
  return view;
}

/** A warp press being painted: its pixels and its gesture. */
interface WarpInProgress {
  readonly press: WarpPress;
  gesture: WarpGesture;
}

/** A wand press being filled (SPM-22; composed since SPM-23): what it selects from, and its drag. */
interface WandPress {
  readonly layerId: string;
  /** The target's pixels when the press began; every fill runs on this snapshot. */
  readonly image: RgbaImage;
  readonly transform: Transform;
  /** How the click combines with the selection already on the canvas. */
  readonly mode: WandMode;
  /** The selection's contributions the press composes onto (empty for a replacing click). */
  readonly base: readonly Contribution[];
  gesture: WandGesture;
  /** The tolerance of the last committed fill. */
  filled: number;
  /**
   * The selection state this press's own step landed (undefined before the
   * first landed fill, and null for a step that emptied the selection), so
   * its refills amend that step — never one this press no longer owns.
   */
  stepped: Region | null | undefined;
  /** Counts fills; the latest wins when a drag outruns the IPC. */
  fills: number;
}

let openFileHook: ((path: string, showEditor: () => void, origin?: StickerOrigin) => Promise<void>) | null = null;
let openThumbnailHook: ((path: string, showEditor: () => void, from: ThumbnailOrigin) => Promise<void>) | null = null;
let forgetOriginHook: (() => void) | null = null;

/** What the Editor asks of the app shell. */
export interface EditorNav {
  /** Switch to the Pack Manager showing this sticker (the saved note's link). */
  showSticker(packId: number, stickerId: number): void;
  /** Switch to the Pack Manager showing the pack's thumbnail slot (the saved note's link). */
  showThumbnail(packId: number): void;
}

let editorNav: EditorNav | null = null;

/** The shell tells the Editor how to reach the other views. */
export function setEditorNav(nav: EditorNav): void {
  editorNav = nav;
}

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
 * session asks first, while the caller's view is still showing — unsaved
 * changes, or the gone-origin question for a clean one (owner decision
 * 2026-11-23); then `showEditor` switches to the Editor either way (the
 * canvas must be on screen to measure itself); then, unless the user kept
 * editing, the file opens. `origin` is the sticker it is (Edit): saving then
 * offers to replace it (owner decision 2026-11-22).
 */
export function openFileInEditor(path: string, showEditor: () => void, origin?: StickerOrigin): Promise<void> {
  renderEditor(); // builds the Editor once, which installs the hook
  return openFileHook ? openFileHook(path, showEditor, origin) : Promise.resolve();
}

/**
 * Open the image at `path` in the Editor's Thumbnail mode (SPM-12): the
 * pack view's thumbnail slot sends a new image or a copy of a pack sticker.
 * Saving the session replaces the pack's thumbnail. One session at a time:
 * an open session is asked its questions first, as Open image asks them
 * (unsaved changes, or the gone-origin question for a clean sticker session
 * whose origin is gone). The thumbnail session itself never gets the
 * gone-origin question: a thumbnail is not an origin sticker (deliberate;
 * SPEC §6's warning is about stickers).
 */
export function openThumbnailFileInEditor(path: string, showEditor: () => void, origin: ThumbnailOrigin): Promise<void> {
  renderEditor();
  return openThumbnailHook ? openThumbnailHook(path, showEditor, origin) : Promise.resolve();
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
 * The clean-session close question when the origin sticker is gone (owner
 * decision 2026-11-23, CMT-291; the copy is owner-vetoable at the re-test
 * and lives here, in one place): closing discards this copy of the image.
 */
function confirmCloseOriginGone(): Promise<boolean> {
  return confirmChoice(
    "Sticker no longer exists",
    [el("p", {}, "The sticker this session was editing is no longer in the Library. Closing the editor discards this copy of the image.")],
    { actionLabel: "Close anyway", keepLabel: "Keep editing", danger: true },
  );
}

/** The model's first Remove background asks before its one-time download (ADR-0006); Cancel is the safe choice. */
function confirmModelDownload(sizeBytes: number): Promise<boolean> {
  return confirmChoice(
    "Download the background removal model?",
    [
      el("p", {}, `Background removal needs a one-time download of its model (${megabytes(sizeBytes)}).`),
      el("p", {}, "After that it works offline. You can cancel the download while it runs."),
    ],
    { actionLabel: "Download", keepLabel: "Cancel" },
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
    keepFirst: true, // the owner's order (2026-11-22), unlike the other dialogs
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

function button(label: string, onClick: () => void, variant?: "primary" | "danger"): HTMLButtonElement {
  return el("button", { class: variant ?? "secondary", onclick: onClick }, label) as HTMLButtonElement;
}

// Pure decisions behind the Editor view: no Konva, no DOM, unit-tested.
import { matchNames } from "../../shared/match-names";
import {
  cropOutcome,
  fitToBox,
  KEEP_ONE_LAYER,
  layerBounds,
  localToDoc,
  NOTHING_IN_BOX,
  resizeLongestSide,
  resizeSideProblem,
  scaleLongestSide,
  textLayersOf,
  type CropAction,
  type Doc,
  type Point,
  type Rect,
  type TextLayer,
} from "../model/document";
import { regionBounds, type Region } from "../model/region";
import type { ConstraintSet } from "../model/constraints";
import type { SelectMode } from "../model/session";

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 16;
/** Zoom factor per wheel notch. */
const ZOOM_STEP = 1.1;

/** How the stage shows the document: scale plus the document origin on screen. */
export interface ViewTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * Fit the document into the view with a margin, centred. Never upscales
 * past 100%, so small stickers show their real pixels. The offset is a
 * whole number of device pixels: a half-pixel origin blurs layer edges and
 * shows faint seams between adjacent layers (view only, the model is
 * unaffected).
 */
export function fitView(view: Size, doc: Size, margin: number): ViewTransform {
  const fit = Math.min(
    (view.width - 2 * margin) / doc.width,
    (view.height - 2 * margin) / doc.height,
  );
  const scale = Math.max(MIN_ZOOM, Math.min(1, fit));
  return {
    scale,
    x: Math.round((view.width - doc.width * scale) / 2),
    y: Math.round((view.height - doc.height * scale) / 2),
  };
}

/**
 * Zoom one wheel notch around the pointer (the model's Point, in screen pixels):
 * negative `deltaY` zooms in. The document point under the pointer stays under
 * it. Clamped to MIN/MAX_ZOOM.
 */
export function zoomAround(view: ViewTransform, pointer: Point, deltaY: number): ViewTransform {
  const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.scale * factor));
  const docX = (pointer.x - view.x) / view.scale;
  const docY = (pointer.y - view.y) / view.scale;
  return { scale, x: pointer.x - docX * scale, y: pointer.y - docY * scale };
}

/**
 * Pan by a pointer drag: the view moves by the pointer's travel since the
 * drag began, scale unchanged. `start` is the view when the drag began.
 */
export function panView(start: ViewTransform, startPointer: Point, pointer: Point): ViewTransform {
  return { scale: start.scale, x: start.x + (pointer.x - startPointer.x), y: start.y + (pointer.y - startPointer.y) };
}

/**
 * Why the selection cannot be merged, or null when it can: merging needs
 * two or more layers. Text layers merge too: Rust rasterises them (SPM-9).
 */
export function mergeBlocker(selection: readonly string[]): string | null {
  if (selection.length < 2) return "Select two or more layers to merge.";
  return null;
}

/**
 * Why Cut is disabled, or null when it can run (SPM-9): it needs a
 * selection drawn on the canvas and exactly one selected image layer that
 * the selection touches. Text is cut only after merging it into an image.
 */
export function cutBlocker(doc: Doc, selection: readonly string[], region: Region | null): string | null {
  if (selection.length !== 1) return "Select the one image layer to cut from.";
  const layer = doc.layers.find((l) => l.id === selection[0]);
  if (!layer) return "Select the one image layer to cut from.";
  if (layer.kind === "text") return "Text layers can't be cut: merge the text into an image layer first.";
  if (!region) return "Draw a selection on the canvas with Rectangle or Lasso first.";
  const a = regionBounds(region);
  const b = layerBounds(layer);
  const apart = a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height;
  return apart ? "The selection does not touch the selected layer." : null;
}

/** Where the text-editing overlay goes on screen, in CSS px of the canvas host. */
export interface OverlayPlacement {
  /** Screen position of the anchor point. */
  readonly left: number;
  readonly top: number;
  /** CSS scale (view zoom times the layer's scale) and rotation in degrees. */
  readonly scale: number;
  readonly rotation: number;
  /** The anchor is the overlay's centre (new text) rather than its top-left. */
  readonly centred: boolean;
}

/**
 * Line the text-editing overlay up with a text layer, or centre it on the
 * canvas for new text. The overlay's top-left is the layout's top-left
 * moved up by half the line gap, because CSS centres each line's glyphs in
 * its line height (`line-height: normal` spacing, like the Rust layout).
 */
export function textOverlayPlacement(
  view: ViewTransform,
  layer: Pick<TextLayer, "transform" | "render"> | null,
  canvas: Size,
): OverlayPlacement {
  if (!layer) {
    return {
      left: view.x + (canvas.width / 2) * view.scale,
      top: view.y + (canvas.height / 2) * view.scale,
      scale: view.scale,
      rotation: 0,
      centred: true,
    };
  }
  const m = layer.render.metrics;
  const halfGap = (m.lineHeight - m.ascent - m.descent) / 2;
  const at = localToDoc(layer.transform, m.originX, m.originY - halfGap);
  return {
    left: view.x + at.x * view.scale,
    top: view.y + at.y * view.scale,
    scale: view.scale * layer.transform.scaleX,
    rotation: layer.transform.rotation,
    centred: false,
  };
}

/** Why the selection cannot be deleted, or null when it can (SPEC §6). */
export function deleteBlocker(doc: Doc, selection: readonly string[]): string | null {
  if (selection.length === 0) return "Select the layers to delete.";
  if (selection.length >= doc.layers.length) return KEEP_ONE_LAYER;
  return null;
}

export type SizeTool = "fit" | "longest" | "free";

/**
 * Why a sizing tool is disabled, or null when it can run: the entered value
 * is invalid (free resize only) or the tool would change nothing. `entered`
 * is the free-resize field as a number (NaN when empty); `content` is null
 * while nothing can be measured. Tools 1 and 2 target `constraints.side`;
 * tool 2 is greyed out when the set needs a square canvas (SPEC §6).
 */
export function sizeToolBlocker(
  tool: SizeTool,
  doc: Doc,
  content: Rect | null,
  entered: number,
  constraints: ConstraintSet,
): string | null {
  const target = constraints.side;
  if (tool === "longest" && constraints.square) {
    return `A ${constraints.mode} must be exactly ${target}×${target}, so use Fit to ${target}×${target}.`;
  }
  if (tool === "free") {
    const problem = resizeSideProblem(entered);
    if (problem) return problem;
  }
  if (!content) return "There is nothing to resize.";
  if (tool === "fit") {
    return fitToBox(doc, content, target) === doc ? `The image already fills ${target}×${target}.` : null;
  }
  const side = tool === "longest" ? target : entered;
  const next = tool === "longest" ? scaleLongestSide(doc, content, side) : resizeLongestSide(doc, content, side);
  return next === doc ? `The image's longest side is already ${side} px.` : null;
}

/** Ctrl (Cmd on macOS) or Shift + click toggles a layer in or out of the selection. */
export function selectModeFor(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): SelectMode {
  return event.ctrlKey || event.metaKey || event.shiftKey ? "toggle" : "replace";
}

/**
 * Why Crop is disabled, or null when it can run: it would change nothing
 * (every layer already inside the box), or it would discard every layer
 * (a session keeps at least one, SPEC §6).
 */
export function cropBlocker(plan: readonly CropAction[], box: Rect): string | null {
  switch (cropOutcome(plan)) {
    case "nothing-outside":
      return `Everything is already inside the ${box.width}×${box.height} box.`;
    case "nothing-inside":
      return NOTHING_IN_BOX;
    case "crop":
      return null;
  }
}

/**
 * The note after a Crop that turned crossing text layers into images (owner
 * decision 2026-11-22), or null when no text was converted. Undo brings
 * the text back.
 */
export function cropTextNotice(doc: Doc, plan: readonly CropAction[]): string | null {
  const converted = plan.filter((a, i) => a.kind === "clip" && doc.layers[i]?.kind === "text").length;
  if (converted === 0) return null;
  return converted === 1
    ? "1 text layer crossed the crop edge and was converted to an image."
    : `${converted} text layers crossed the crop edge and were converted to images.`;
}

/**
 * Why the text tool can't be used, or null: the installed fonts are still
 * loading (`fonts` null) or could not be listed (`problem`).
 */
export function textBlocker(fonts: readonly string[] | null, problem: string | null): string | null {
  return fonts === null ? (problem ?? "Looking for the installed fonts…") : null;
}

/**
 * Why Edit text is disabled, or null: the text tool is blocked (`textReason`)
 * or the selection is not exactly one text layer.
 */
export function editTextBlocker(textReason: string | null, doc: Doc, selection: readonly string[]): string | null {
  if (textReason) return textReason;
  return selection.length === 1 && textLayersOf(doc, selection).length === 1 ? null : "Select one text layer to edit.";
}

/**
 * The fonts the picker lists: the installed families, plus `family`
 * when it is set but not installed (a layer in a font that has since gone
 * still shows its font). Pure: the installed list is never changed, and it
 * is returned as is when nothing is added.
 */
export function fontChoices(installed: readonly string[], family: string): readonly string[] {
  return family === "" || installed.includes(family) ? installed : [...installed, family];
}

/**
 * The fonts the picker lists for a typed `query` (owner decision
 * 2026-11-22: type-to-search): case-insensitive, names starting with the
 * query first, then names containing it, each group in list order. An
 * empty query lists every font.
 */
export function matchFonts(fonts: readonly string[], query: string): readonly string[] {
  return matchNames(fonts, query, (f) => f);
}

/** What Esc clears: the cut selection first, then the layer selection (SPEC §6). */
export function escapeTarget(region: Region | null): "region" | "selection" {
  return region ? "region" : "selection";
}

/** Ctrl/Cmd+X (no Shift or Alt) runs the Cut tool; it never touches the clipboard (SPEC §6). */
export function isCutShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "x";
}

/** The reasons behind the layer panel's disabled actions. */
export interface LayerReasons {
  readonly merge: string | null;
  readonly delete: string | null;
  readonly cut: string | null;
  readonly editText: string | null;
}

/**
 * The hint under the layer list, explaining disabled actions once something
 * is selected: merge and delete always; Cut only while a selection is drawn
 * on the canvas (else it is just not in use); Edit text only when a text
 * layer is selected.
 */
export function layerHint(
  doc: Doc,
  selection: readonly string[],
  region: Region | null,
  reasons: LayerReasons,
): string {
  if (selection.length === 0) return "";
  const relevant = [
    reasons.merge,
    reasons.delete,
    region ? reasons.cut : null,
    textLayersOf(doc, selection).length > 0 ? reasons.editText : null,
  ];
  return relevant.filter((r) => r !== null).join(" ");
}

/** A CSS font-family value naming exactly `family`: quoted, with `"` and `\` escaped, so any name works. */
export function cssFontFamily(family: string): string {
  return `"${family.replace(/["\\]/g, "\\$&")}"`;
}

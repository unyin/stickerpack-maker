// Typed wrappers around the Editor's Rust commands (src-tauri/src/commands.rs,
// "Editor" section, and src-tauri/src/save_commands.rs for editor_save_image;
// pixel work lives in src-tauri/src/editor/, ADR-0005).
import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { RgbaImage } from "./model/image";
import type { Effect, EffectResult } from "./model/effects";
import { layerInput, textStyleOf, type CropInput, type Doc, type CutResult, type LayerInput, type Point, type Rect, type TextRender, type TextStyle, type Transform } from "./model/document";
import type { Contribution } from "./model/region";
import type { WandMask } from "./model/wand";
import { IMPORT_EXTENSIONS } from "../shared/import-extensions";
import type { SaveFormat, SaveOutcome, SaveTarget } from "./save";

/** Extensions the Editor imports (shared with the Pack Manager). */
export { IMPORT_EXTENSIONS } from "../shared/import-extensions";

/** Largest side imported without the scale-to-fit dialog (SPEC §6). */
export { IMPORT_MAX_SIDE } from "./model/image";

/** Header-only probe result (serde camelCase from ImageInfo). */
export interface ImageInfo {
  width: number;
  height: number;
  exceedsCap: boolean;
}

export function probeImage(path: string): Promise<ImageInfo> {
  return invoke<ImageInfo>("editor_probe_image", { path });
}

/**
 * Decode an image in Rust. `scaleToFit` is "Scale to fit" in the import
 * cap dialog; without it an oversize image is refused.
 */
export async function importImage(
  path: string,
  scaleToFit: boolean,
): Promise<RgbaImage> {
  const frame = await invoke<ArrayBuffer>("editor_import_image", {
    path,
    scaleToFit,
  });
  return decodeFrame(frame);
}

/**
 * Parse a binary frame from Rust (`Rgba::to_frame`) starting at `offset`:
 * u32 LE width, u32 LE height, then width*height*4 RGBA bytes. The pixels
 * view shares the buffer (no copy, even for 16 MB images).
 */
export function decodeFrame(frame: ArrayBuffer, offset = 0): RgbaImage {
  const size = frame.byteLength - offset;
  if (size < 8) throw new Error("image frame is truncated");
  const header = new DataView(frame, offset, 8);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  const expected = 8 + width * height * 4;
  if (size !== expected) {
    throw new Error(`image frame has ${size} bytes, expected ${expected} for ${width}x${height}`);
  }
  return { width, height, pixels: new Uint8ClampedArray(frame, offset + 8) };
}

/** Native picker for an image to edit. Returns null when cancelled. */
export async function pickImageFile(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    title: "Choose an image to edit",
    filters: [{ name: "Images", extensions: IMPORT_EXTENSIONS }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Header naming each layer's size and transform; mirrors MERGE_LAYERS_HEADER. */
export const MERGE_LAYERS_HEADER = "x-merge-layers";

/**
 * Call a command whose request is raw bytes plus one JSON header: the shape
 * every pixel command shares (the body stays raw, never JSON, ADR-0005).
 */
function invokeRaw<T = ArrayBuffer>(command: string, body: Uint8Array, header: string, meta: unknown): Promise<T> {
  return invoke<T>(command, body, { headers: { [header]: asciiJson(meta) } });
}

/**
 * JSON with every non-ASCII character escaped (`\u00e9`), so it is a valid
 * HTTP header value: a header carries only visible ASCII, and text layers
 * can hold any character ("café", emoji). The JSON means the same.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A raster's pixels as the bytes of a request body (only the view, not its whole buffer). */
function bytesOf(image: RgbaImage): Uint8Array {
  return new Uint8Array(image.pixels.buffer, image.pixels.byteOffset, image.pixels.byteLength);
}

/**
 * The wire form of merge and crop inputs: raster pixels concatenated as
 * one raw body, and per layer its size and transform (plus, for text, its
 * text and no body bytes; the size is then its rendered box).
 */
function encodeLayers(inputs: readonly LayerInput[]): { body: Uint8Array; meta: Record<string, unknown>[] } {
  const parts = inputs.map((i) =>
    "image" in i
      ? { pixels: bytesOf(i.image), meta: { width: i.image.width, height: i.image.height, transform: i.transform } }
      : {
          pixels: null,
          meta: { width: i.render.image.width, height: i.render.image.height, transform: i.transform, text: i.text },
        },
  );
  const body = new Uint8Array(parts.reduce((n, p) => n + (p.pixels?.length ?? 0), 0));
  let offset = 0;
  for (const { pixels } of parts) {
    if (!pixels) continue;
    body.set(pixels, offset);
    offset += pixels.length;
  }
  return { body, meta: parts.map((p) => p.meta) };
}

/** A merged image and where its top-left sits in the document. */
export interface PlacedImage {
  x: number;
  y: number;
  image: RgbaImage;
}

/**
 * Composite layers (bottom to top) in Rust (ADR-0005), text included.
 * Pixels go as one raw body; sizes, transforms and text ride in a header.
 */
export async function mergeImages(inputs: readonly LayerInput[]): Promise<PlacedImage> {
  const { body, meta } = encodeLayers(inputs);
  const frame = await invokeRaw("editor_merge_layers", body, MERGE_LAYERS_HEADER, meta);
  return decodePlacedFrame(frame);
}

/** Parse `PlacedImage::to_frame`: i32 LE x, i32 LE y, then an image frame. */
export function decodePlacedFrame(frame: ArrayBuffer): PlacedImage {
  if (frame.byteLength < 8) throw new Error("placed image frame is truncated");
  const origin = new DataView(frame, 0, 8);
  return {
    x: origin.getInt32(0, true),
    y: origin.getInt32(4, true),
    image: decodeFrame(frame, 8),
  };
}

/** Header naming each crop input's size, transform and clip; mirrors CROP_LAYERS_HEADER. */
export const CROP_LAYERS_HEADER = "x-crop-layers";

/**
 * Re-render layers clipped to their rectangles in Rust (ADR-0005), one
 * image per input, each exactly its clip's size; text layers are rasterised.
 * Pixels go as one raw body; sizes, transforms, text and clips ride in a
 * header. The response is the clips' RGBA bytes concatenated, so it is
 * split here by the known sizes.
 */
export async function cropImages(inputs: readonly CropInput[]): Promise<RgbaImage[]> {
  const { body, meta } = encodeLayers(inputs);
  const frame = await invokeRaw(
    "editor_crop_layers",
    body,
    CROP_LAYERS_HEADER,
    meta.map((m, i) => ({ ...m, clip: inputs[i].clip })),
  );
  return splitClips(frame, inputs.map((i) => i.clip));
}

/** Split concatenated RGBA bytes into one image per clip; the sizes must add up exactly. */
export function splitClips(frame: ArrayBuffer, clips: readonly Rect[]): RgbaImage[] {
  const expected = clips.reduce((n, c) => n + c.width * c.height * 4, 0);
  if (frame.byteLength !== expected) {
    throw new Error(`cropped pixels have ${frame.byteLength} bytes, expected ${expected}`);
  }
  let offset = 0;
  return clips.map((c) => {
    const length = c.width * c.height * 4;
    const pixels = new Uint8ClampedArray(frame, offset, length);
    offset += length;
    return { width: c.width, height: c.height, pixels };
  });
}

/** The system's font families (Rust scans them once), sorted. */
export function listFonts(): Promise<string[]> {
  return invoke<string[]>("editor_list_fonts");
}

/** Draw a text layer at scale 1 in Rust: the pixels the view shows and the layer's box (SPM-9). */
export async function renderText(style: TextStyle): Promise<TextRender> {
  const frame = await invoke<ArrayBuffer>("editor_render_text", { spec: textStyleOf(style) });
  return decodeTextFrame(frame);
}

/** Parse `TextRender::to_frame`: five f32 LE metrics, then an image frame. */
export function decodeTextFrame(frame: ArrayBuffer): TextRender {
  if (frame.byteLength < 20) throw new Error("text frame is truncated");
  const m = new DataView(frame, 0, 20);
  const f = (i: number) => m.getFloat32(i * 4, true);
  return {
    metrics: { originX: f(0), originY: f(1), ascent: f(2), descent: f(3), lineHeight: f(4) },
    image: decodeFrame(frame, 20),
  };
}

/** Header carrying a cut's layer size, transform and polygon; mirrors CUT_LAYER_HEADER. */
export const CUT_LAYER_HEADER = "x-cut-layer";

/**
 * Cut a selection (a polygon in document pixels) out of a raster layer in
 * Rust (SPM-9): the layer with a hole, and the cutout with its top-left in
 * the layer's own pixel grid. Rust refuses a selection with nothing visible.
 */
export async function cutImage(image: RgbaImage, transform: Transform, polygon: readonly Point[]): Promise<CutResult> {
  const meta = { width: image.width, height: image.height, transform, polygon: polygon.map((p) => [p.x, p.y]) };
  const frame = await invokeRaw("editor_cut_layer", bytesOf(image), CUT_LAYER_HEADER, meta);
  return decodeCutFrame(frame, image.width, image.height);
}

/** Parse `Cut::to_frame`: the hole's RGBA bytes (the source's size), then a placed frame. */
export function decodeCutFrame(frame: ArrayBuffer, width: number, height: number): CutResult {
  const holeBytes = width * height * 4;
  if (frame.byteLength < holeBytes) throw new Error("cut frame is truncated");
  const hole: RgbaImage = { width, height, pixels: new Uint8ClampedArray(frame, 0, holeBytes) };
  const placed = decodePlacedFrame(frame.slice(holeBytes));
  return { hole, cutout: placed.image, x: placed.x, y: placed.y };
}

// ---- Magic-wand selection (SPM-22) ----

/** Header carrying a wand request's layer size and transform, the clicked spot and the tolerance; mirrors WAND_HEADER. */
export const WAND_HEADER = "x-wand-select";

/**
 * Select the colour-similar contiguous region around a click (SPM-22):
 * Rust flood-fills the layer and returns its coverage mask — 255 inside,
 * 128 on the 1-px feather ring, or hard edges throughout with `feathered`
 * false (the Feather checkbox, on by default; owner decision
 * 2026-11-24) — cropped to the selected bounds and in the layer's own
 * pixel grid. A fully transparent or out-of-layer click is refused.
 */
export async function wandSelect(
  image: RgbaImage,
  transform: Transform,
  seed: Point,
  tolerance: number,
  feathered: boolean,
): Promise<WandMask> {
  const meta = { width: image.width, height: image.height, transform, seed: [seed.x, seed.y], tolerance, feather: feathered };
  const frame = await invokeRaw("editor_wand_select", bytesOf(image), WAND_HEADER, meta);
  return decodeWandFrame(frame);
}

/** Parse `WandMask::to_frame`: i32 LE x, i32 LE y, u32 LE width, u32 LE height, then the coverage bytes. */
export function decodeWandFrame(frame: ArrayBuffer): WandMask {
  if (frame.byteLength < 16) throw new Error("wand mask frame is truncated");
  const header = new DataView(frame, 0, 16);
  const mask = {
    x: header.getInt32(0, true),
    y: header.getInt32(4, true),
    width: header.getUint32(8, true),
    height: header.getUint32(12, true),
  };
  const expected = mask.width * mask.height;
  if (frame.byteLength !== 16 + expected) {
    throw new Error(
      `wand mask frame has ${frame.byteLength - 16} coverage bytes, expected ${expected} for ${mask.width}x${mask.height}`,
    );
  }
  return { ...mask, coverage: new Uint8Array(frame, 16) };
}

/** Header carrying a mask cut's layer size and transform, the mask's place and the mode; mirrors CUT_MASK_HEADER. */
export const CUT_MASK_HEADER = "x-cut-mask";

/** The layer's bytes followed by the mask's coverage, as one raw body. */
function bytesWithMask(image: RgbaImage, mask: WandMask): Uint8Array {
  const body = new Uint8Array(image.pixels.length + mask.coverage.length);
  body.set(bytesOf(image), 0);
  body.set(mask.coverage, image.pixels.length);
  return body;
}

/** The mask's place as the cut/erase request carries it. */
function maskPlace(mask: WandMask): Record<string, number> {
  return { x: mask.x, y: mask.y, width: mask.width, height: mask.height };
}

/**
 * Cut a wand selection out of a raster layer in Rust (SPM-22): the layer
 * with a feathered hole, and the covered pixels as a new floating cutout.
 */
export async function liftMask(image: RgbaImage, transform: Transform, mask: WandMask): Promise<CutResult> {
  const meta = { width: image.width, height: image.height, transform, mask: maskPlace(mask) };
  const frame = await invokeRaw("editor_cut_mask", bytesWithMask(image, mask), CUT_MASK_HEADER, meta);
  return decodeCutFrame(frame, image.width, image.height);
}

/** Erase a wand selection's pixels from a raster layer in Rust (SPM-22): each covered pixel keeps the mask's uncovered share of its alpha. */
export async function eraseMask(image: RgbaImage, transform: Transform, mask: WandMask): Promise<RgbaImage> {
  const meta = { width: image.width, height: image.height, transform, mask: maskPlace(mask), mode: "erase" };
  const frame = await invokeRaw("editor_cut_mask", bytesWithMask(image, mask), CUT_MASK_HEADER, meta);
  return decodeFrame(frame);
}

/** Header carrying a compose request's grid (size and transform) and its contributions; mirrors COMPOSE_MASK_HEADER. */
export const COMPOSE_MASK_HEADER = "x-compose-mask";

/**
 * Merge a floating selection's contributions into one grid's coverage mask
 * in Rust (SPM-23): the target layer's own grid when Cut or Delete applies
 * the selection, the document's for the dashed-outline preview. The wire
 * form of a wand contribution carries the mask's place instead of its
 * bytes; the coverage travels as the raw body, concatenated in order.
 * Response: the merged mask, cropped to the covered bounds — a zero-size
 * mask when nothing is covered.
 */
export async function composeSelection(
  width: number,
  height: number,
  transform: Transform,
  contributions: readonly Contribution[],
): Promise<WandMask> {
  let length = 0;
  for (const contribution of contributions) {
    if (contribution.kind === "wand") length += contribution.mask.coverage.length;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  const wire = contributions.map((contribution) => {
    if (contribution.kind === "poly") return contribution;
    body.set(contribution.mask.coverage, offset);
    offset += contribution.mask.coverage.length;
    return { kind: "mask", op: contribution.op, transform: contribution.transform, ...maskPlace(contribution.mask) };
  });
  const frame = await invokeRaw("editor_compose_mask", body, COMPOSE_MASK_HEADER, { width, height, transform, contributions: wire });
  return decodeWandFrame(frame);
}

/**
 * Erase a Rectangle/Lasso selection from a raster layer in Rust (SPM-22,
 * owner decision 2026-11-24: Delete with a selection drawn erases it):
 * whole pixels, exactly what Cut's hole leaves.
 */
export async function eraseRegion(image: RgbaImage, transform: Transform, polygon: readonly Point[]): Promise<RgbaImage> {
  const meta = { width: image.width, height: image.height, transform, polygon: polygon.map((p) => [p.x, p.y]), mode: "erase" };
  const frame = await invokeRaw("editor_cut_layer", bytesOf(image), CUT_LAYER_HEADER, meta);
  return decodeFrame(frame);
}

/** Header saying whether a pasted image over the import cap may be scaled; mirrors SCALE_TO_FIT_HEADER. */
export const SCALE_TO_FIT_HEADER = "x-scale-to-fit";

/** Probe a pasted image's encoded bytes (PNG, JPEG or WEBP): its size and the import cap. */
export function probePasted(bytes: Uint8Array): Promise<ImageInfo> {
  return invoke<ImageInfo>("editor_probe_pasted", bytes);
}

/** Decode a pasted image in Rust with the import cap rule; `scaleToFit` is "Scale to fit" in the cap dialog. */
export async function importPasted(bytes: Uint8Array, scaleToFit: boolean): Promise<RgbaImage> {
  const frame = await invokeRaw("editor_import_pasted", bytes, SCALE_TO_FIT_HEADER, scaleToFit);
  return decodeFrame(frame);
}

/** Header carrying an effect request's layer size, transform (or text) and settings; mirrors EFFECT_HEADER. */
export const EFFECT_HEADER = "x-effect";

/**
 * Draw an outline or fuzzy glow on one layer in Rust (SPM-8): the live
 * preview and the result Apply bakes in are this one call (ADR-0008). A
 * text layer goes as text and comes back as pixels; the result is larger
 * than the layer, with its new transform. Since SPM-18 the Outline tool
 * on a text layer restyles through renderText and never calls here —
 * except a layer scaled to nothing, which falls through and is refused
 * here like any degenerate transform; this call is Glow on text and
 * every raster target.
 */
export async function applyEffect(input: LayerInput, effect: Effect): Promise<EffectResult> {
  const { body, meta } = encodeLayers([input]);
  const frame = await invokeRaw("editor_apply_effect", body, EFFECT_HEADER, { ...meta[0], effect });
  return decodeEffectFrame(frame);
}

/** Parse `EffectResult::to_frame`: the transform as five f32 LE (x, y, scaleX, scaleY, rotation), then an image frame. */
export function decodeEffectFrame(frame: ArrayBuffer): EffectResult {
  if (frame.byteLength < 20) throw new Error("effect frame is truncated");
  const t = new DataView(frame, 0, 20);
  const f = (i: number) => t.getFloat32(i * 4, true);
  return {
    transform: { x: f(0), y: f(1), scaleX: f(2), scaleY: f(3), rotation: f(4) },
    image: decodeFrame(frame, 20),
  };
}

// ---- Background removal (SPM-7, ADR-0006) ----

/** Whether the background removal model is cached yet, and its download size (serde camelCase). */
export interface BackgroundModelStatus {
  downloaded: boolean;
  sizeBytes: number;
}

export function backgroundModelStatus(): Promise<BackgroundModelStatus> {
  return invoke<BackgroundModelStatus>("editor_background_model_status");
}

/** A download's progress as Rust reports it (bytes). */
export interface DownloadProgress {
  readonly received: number;
  readonly total: number;
}

/** How a download ended; mirrors Rust's `ml::DownloadOutcome` (serde camelCase). */
export type DownloadOutcome = "done" | "cancelled";

/**
 * Download the model once (Rust checks its size and SHA-256 before keeping
 * it), reporting progress. Resolves "cancelled" after `cancelBackgroundDownload`.
 */
export function downloadBackgroundModel(onProgress: (p: DownloadProgress) => void): Promise<DownloadOutcome> {
  const channel = new Channel<DownloadProgress>();
  channel.onmessage = onProgress;
  return invoke<DownloadOutcome>("editor_download_background_model", { onProgress: channel });
}

export function cancelBackgroundDownload(): Promise<void> {
  return invoke<void>("editor_cancel_background_download");
}

/** Header carrying the layer size of a removal; mirrors REMOVE_BACKGROUND_HEADER. */
export const REMOVE_BACKGROUND_HEADER = "x-remove-background";

/** The layer with its background made transparent, in Rust (alpha only; colours unchanged). */
export async function removeImageBackground(image: RgbaImage): Promise<RgbaImage> {
  const meta = { width: image.width, height: image.height };
  const frame = await invokeRaw("editor_remove_background", bytesOf(image), REMOVE_BACKGROUND_HEADER, meta);
  const out = decodeFrame(frame);
  if (out.width !== image.width || out.height !== image.height) {
    throw new Error("background removal returned an image of another size");
  }
  return out;
}

/** Header carrying the save request (canvas, layers, format, target); mirrors SAVE_HEADER. */
export const SAVE_HEADER = "x-save-image";

/**
 * Save the document (SPEC §6, SPM-10): Rust flattens what is inside the
 * canvas, encodes it as `format` within the size cap and writes it to
 * `target` through the Library core. Layers go as for merge (raster pixels
 * as the raw body, text as text). A canvas that misses the sticker
 * constraint set is refused (rejects); over the cap resolves `tooLarge`.
 */
export function saveImage(doc: Doc, format: SaveFormat, target: SaveTarget): Promise<SaveOutcome> {
  const { body, meta } = encodeLayers(doc.layers.map(layerInput));
  return invokeRaw<SaveOutcome>("editor_save_image", body, SAVE_HEADER, {
    width: doc.width,
    height: doc.height,
    layers: meta,
    format,
    target,
  });
}

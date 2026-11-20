// Typed wrappers around the Editor's Rust commands (src-tauri/src/commands.rs,
// "Editor" section; pixel work lives in src-tauri/src/editor/, ADR-0005).
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { RgbaImage } from "./model/image";
import type { CutResult, Layer, Point, Rect, TextRender, TextStyle, Transform } from "./model/document";

/** Extensions the Editor imports; mirrors IMPORT_EXTENSIONS in import.rs. */
export const IMPORT_EXTENSIONS = ["jpg", "jpeg", "jfif", "png", "webp"];

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
 * Decode an image in Rust. `scaleToFit` is the owner's OK in the import
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

/** Header naming each merge input's size and transform; mirrors MERGE_LAYERS_HEADER. */
export const MERGE_LAYERS_HEADER = "x-merge-layers";

/**
 * A layer handed to Rust for merging or cropping: a raster layer's pixels,
 * or a text layer's text (Rust rasterises it at its transform, SPM-9).
 */
export type MergeInput =
  | { image: RgbaImage; transform: Transform }
  | { text: TextStyle; render: TextRender; transform: Transform };

/** A model layer as a merge or crop input. */
export function layerInput(layer: Layer): MergeInput {
  if (layer.kind === "raster") return { image: layer.image, transform: layer.transform };
  const { text, fontFamily, fontSize, color } = layer;
  return { text: { text, fontFamily, fontSize, color }, render: layer.render, transform: layer.transform };
}

/**
 * The wire form of merge and crop inputs: raster pixels concatenated as
 * one raw body, and per layer its size and transform (plus, for text, its
 * text and no body bytes; the size is then its rendered box).
 */
function encodeLayers(inputs: readonly MergeInput[]): { body: Uint8Array; meta: Record<string, unknown>[] } {
  const rasters = inputs.flatMap((i) => ("image" in i ? [i.image] : []));
  const body = new Uint8Array(rasters.reduce((n, img) => n + img.pixels.length, 0));
  let offset = 0;
  for (const img of rasters) {
    body.set(img.pixels, offset);
    offset += img.pixels.length;
  }
  const meta = inputs.map((i) =>
    "image" in i
      ? { width: i.image.width, height: i.image.height, transform: i.transform }
      : { width: i.render.image.width, height: i.render.image.height, transform: i.transform, text: i.text },
  );
  return { body, meta };
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
export async function mergeImages(inputs: readonly MergeInput[]): Promise<PlacedImage> {
  const { body, meta } = encodeLayers(inputs);
  const frame = await invoke<ArrayBuffer>("editor_merge_layers", body, {
    headers: { [MERGE_LAYERS_HEADER]: JSON.stringify(meta) },
  });
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

/** A layer handed to Rust for cropping, with the whole pixels it keeps. */
export type CropInput = MergeInput & { clip: Rect };

/**
 * Re-render layers clipped to their rectangles in Rust (ADR-0005), one
 * image per input, each exactly its clip's size; text layers are rasterised.
 * Pixels go as one raw body; sizes, transforms, text and clips ride in a
 * header. The response is the clips' RGBA bytes concatenated, so it is
 * split here by the known sizes.
 */
export async function cropImages(inputs: readonly CropInput[]): Promise<RgbaImage[]> {
  const encoded = encodeLayers(inputs);
  const body = encoded.body;
  const meta = encoded.meta.map((m, i) => ({ ...m, clip: inputs[i].clip }));
  const frame = await invoke<ArrayBuffer>("editor_crop_layers", body, {
    headers: { [CROP_LAYERS_HEADER]: JSON.stringify(meta) },
  });
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
  const { text, fontFamily, fontSize, color } = style;
  const frame = await invoke<ArrayBuffer>("editor_render_text", { spec: { text, fontFamily, fontSize, color } });
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
  const frame = await invoke<ArrayBuffer>("editor_cut_layer", new Uint8Array(image.pixels.buffer, image.pixels.byteOffset, image.pixels.byteLength), {
    headers: { [CUT_LAYER_HEADER]: JSON.stringify(meta) },
  });
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

/** Header saying whether a pasted image over the import cap may be scaled; mirrors SCALE_TO_FIT_HEADER. */
export const SCALE_TO_FIT_HEADER = "x-scale-to-fit";

/** Probe a pasted image's encoded bytes (PNG, JPEG or WEBP): its size and the import cap. */
export function probePasted(bytes: Uint8Array): Promise<ImageInfo> {
  return invoke<ImageInfo>("editor_probe_pasted", bytes);
}

/** Decode a pasted image in Rust with the import cap rule; `scaleToFit` is the OK in the cap dialog. */
export async function importPasted(bytes: Uint8Array, scaleToFit: boolean): Promise<RgbaImage> {
  const frame = await invoke<ArrayBuffer>("editor_import_pasted", bytes, {
    headers: { [SCALE_TO_FIT_HEADER]: String(scaleToFit) },
  });
  return decodeFrame(frame);
}

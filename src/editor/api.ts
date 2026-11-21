// Typed wrappers around the Editor's Rust commands (src-tauri/src/commands.rs,
// "Editor" section; pixel work lives in src-tauri/src/editor/, ADR-0005).
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { RgbaImage } from "./model/image";
import type { Rect, Transform } from "./model/document";

import { IMPORT_EXTENSIONS } from "../shared/import-extensions";

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

/** A raster layer handed to Rust for merging. */
export interface MergeInput {
  image: RgbaImage;
  transform: Transform;
}

/** A merged image and where its top-left sits in the document. */
export interface PlacedImage {
  x: number;
  y: number;
  image: RgbaImage;
}

/**
 * Composite raster layers (bottom to top) in Rust (ADR-0005). Pixels go as
 * one raw body; sizes and transforms ride in a header.
 */
export async function mergeImages(inputs: readonly MergeInput[]): Promise<PlacedImage> {
  const total = inputs.reduce((n, i) => n + i.image.pixels.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const input of inputs) {
    body.set(input.image.pixels, offset);
    offset += input.image.pixels.length;
  }
  const meta = inputs.map((i) => ({
    width: i.image.width,
    height: i.image.height,
    transform: i.transform,
  }));
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

/** A raster layer handed to Rust for cropping, with the whole pixels it keeps. */
export interface CropInput {
  image: RgbaImage;
  transform: Transform;
  clip: Rect;
}

/**
 * Re-render raster layers clipped to their rectangles in Rust (ADR-0005),
 * one image per input, each exactly its clip's size. Pixels go as one raw
 * body; sizes, transforms and clips ride in a header. The response is the
 * clips' RGBA bytes concatenated, so it is split here by the known sizes.
 */
export async function cropImages(inputs: readonly CropInput[]): Promise<RgbaImage[]> {
  const body = new Uint8Array(inputs.reduce((n, i) => n + i.image.pixels.length, 0));
  let offset = 0;
  for (const input of inputs) {
    body.set(input.image.pixels, offset);
    offset += input.image.pixels.length;
  }
  const meta = inputs.map((i) => ({
    width: i.image.width,
    height: i.image.height,
    transform: i.transform,
    clip: i.clip,
  }));
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

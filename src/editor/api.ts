// Typed wrappers around the Editor's Rust commands (src-tauri/src/commands.rs,
// "Editor" section; pixel work lives in src-tauri/src/editor/, ADR-0005).
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Transform } from "./model/document";

/** Extensions the Editor imports; mirrors IMPORT_EXTENSIONS in import.rs. */
export const IMPORT_EXTENSIONS = ["jpg", "jpeg", "jfif", "png", "webp"];

/** Largest side imported without the scale-to-fit dialog (SPEC §6). */
export const IMPORT_MAX_SIDE = 2000;

/** Header-only probe result (serde camelCase from ImageInfo). */
export interface ImageInfo {
  width: number;
  height: number;
  exceedsCap: boolean;
}

/** A straight (non-premultiplied) RGBA8 image, as canvas ImageData uses. */
export interface RgbaImage {
  width: number;
  height: number;
  /** Backed by a plain ArrayBuffer (never shared), as ImageData requires. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

export function probeImage(path: string): Promise<ImageInfo> {
  return invoke<ImageInfo>("editor_probe_image", { path });
}

/**
 * Decode an image in Rust. `scaleToFit` is the owner's OK in the 2000x2000
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

/** Parse `Placed::to_frame`: i32 LE x, i32 LE y, then an image frame. */
export function decodePlacedFrame(frame: ArrayBuffer): PlacedImage {
  if (frame.byteLength < 8) throw new Error("placed image frame is truncated");
  const origin = new DataView(frame, 0, 8);
  return {
    x: origin.getInt32(0, true),
    y: origin.getInt32(4, true),
    image: decodeFrame(frame, 8),
  };
}

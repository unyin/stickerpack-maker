// Typed wrappers around the Editor's Rust commands (src-tauri/src/commands.rs,
// "Editor" section; pixel work lives in src-tauri/src/editor/, ADR-0005).
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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
  pixels: Uint8ClampedArray;
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
 * Parse a binary frame from Rust (`Rgba::to_frame`): u32 LE width, u32 LE
 * height, then width*height*4 RGBA bytes. The pixels view shares the buffer.
 */
export function decodeFrame(frame: ArrayBuffer): RgbaImage {
  if (frame.byteLength < 8) throw new Error("image frame is truncated");
  const header = new DataView(frame, 0, 8);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  const expected = 8 + width * height * 4;
  if (frame.byteLength !== expected) {
    throw new Error(
      `image frame has ${frame.byteLength} bytes, expected ${expected} for ${width}x${height}`,
    );
  }
  return { width, height, pixels: new Uint8ClampedArray(frame, 8) };
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

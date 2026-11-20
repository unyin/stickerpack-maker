// Pixel data as the model holds it (ADR-0005): no Konva, no IPC.
import limits from "../../shared/limits.json";

/** A straight (non-premultiplied) RGBA8 image, as canvas ImageData uses. */
export interface RgbaImage {
  width: number;
  height: number;
  /** Backed by a plain ArrayBuffer (never shared), as ImageData requires. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Largest side the Editor accepts: the import cap (SPEC §6, bigger images
 * need the scale-to-fit OK) and the free-resize range (1 to this). Its one
 * definition is src/shared/limits.json, which Rust reads too (build.rs).
 */
export const IMPORT_MAX_SIDE: number = limits.importMaxSide;

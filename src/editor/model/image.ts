// Pixel data as the model holds it (ADR-0005): no Konva, no IPC.

/** A straight (non-premultiplied) RGBA8 image, as canvas ImageData uses. */
export interface RgbaImage {
  width: number;
  height: number;
  /** Backed by a plain ArrayBuffer (never shared), as ImageData requires. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Largest side the Editor accepts, once: the import cap (SPEC §6, bigger
 * images need the scale-to-fit OK) and the free-resize range (1 to this).
 */
export const MAX_SIDE = 2000;

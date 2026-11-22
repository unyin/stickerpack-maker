// Background removal and the refine brush in the document model (SPEC §6,
// SPM-7, ADR-0006). Rust computes the removal; the brush paints in the
// webview (brush.ts). Both change only a raster layer's pixels and keep its
// restore source: the pixels from before the first of them, which the
// Restore brush paints back. No Konva, no DOM.
import { layerIndex, type Doc, type Layer, type RasterLayer } from "./document";
import type { RgbaImage } from "./image";

const SELECT_ONE_IMAGE = "Select one image layer, or none for the base image.";

/** The layer a background tool works on, or why there is none. */
export type BackgroundTarget = { readonly layer: RasterLayer } | { readonly reason: string };

/**
 * The selected layer, or the base image (the bottom layer) when nothing is
 * selected, as Outline and glow target (SPEC §6). Only image layers have
 * pixels to change; text is merged into an image first.
 */
export function backgroundTarget(doc: Doc, selection: readonly string[]): BackgroundTarget {
  if (selection.length > 1) return { reason: SELECT_ONE_IMAGE };
  const layer: Layer | undefined =
    selection.length === 1 ? doc.layers.find((l) => l.id === selection[0]) : doc.layers[0];
  if (!layer) return { reason: SELECT_ONE_IMAGE };
  if (layer.kind === "text") {
    return {
      reason:
        selection.length === 1
          ? "Text layers have no background: merge the text into an image layer first."
          : "The base layer is text: select an image layer.",
    };
  }
  return { layer };
}

/** Why the Restore brush cannot paint on `layer`, or null when it can. */
export function restoreBlocker(layer: RasterLayer): string | null {
  return layer.restoreSource
    ? null
    : "Nothing to restore on this layer yet: Restore brings back what Remove background or the Erase brush took away.";
}

/**
 * Give a raster layer new pixels from background removal or a refine
 * stroke as ONE operation, keeping (or, the first time, starting) its
 * restore source: the pixels from before the first such change. The same
 * pixels return the document as is (no undo step).
 */
export function refineLayerPixels(doc: Doc, id: string, image: RgbaImage): Doc {
  const index = layerIndex(doc, id);
  const layer = doc.layers[index];
  if (layer.kind !== "raster") throw new Error(`layer ${id} is not a raster layer`);
  if (image === layer.image) return doc;
  if (image.width !== layer.image.width || image.height !== layer.image.height) {
    throw new Error(`the new pixels for layer ${id} do not match its size`);
  }
  const layers = doc.layers.slice();
  layers[index] = { ...layer, image, restoreSource: layer.restoreSource ?? layer.image };
  return { ...doc, layers };
}

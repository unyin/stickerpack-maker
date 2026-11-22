// Outline and fuzzy glow (SPEC §6, SPM-8): which layer an effect works on,
// its settings, and baking Rust's result into the document. One-shot
// (owner decision 2026-11-22, CMT-183): a live preview shows the result
// while the settings change, and Apply bakes it in as ONE undo step; the
// preview itself never enters the document or its history (CMT-186).
import { layerIndex, type Doc, type Layer, type RasterLayer, type Transform } from "./document";
import type { RgbaImage } from "./image";

/** The effects with settings and an Apply button. */
export type EffectKind = "outline" | "glow";

/** The effect a canvas tool previews and applies, or null for every other tool. */
export function effectKindOf(tool: string): EffectKind | null {
  return tool === "outline" || tool === "glow" ? tool : null;
}

/** Outline settings as the controls hold them: a #rrggbb colour and a width in document px. */
export interface OutlineSettings {
  readonly color: string;
  readonly width: number;
}

/** Fuzzy glow settings as the controls hold them: radius in document px, softness and opacity in percent. */
export interface GlowSettings {
  readonly color: string;
  readonly radius: number;
  readonly softness: number;
  readonly opacity: number;
}

/** A whole-number slider range with its starting value. */
export interface Range {
  readonly min: number;
  readonly max: number;
  readonly initial: number;
}

// The ranges and defaults are a parked owner decision (SPM-8 tracker):
// change them here, nothing else depends on the numbers. Sizes are in
// document px, so they mean the same on screen at any layer scale.
export const OUTLINE_WIDTH: Range = { min: 1, max: 100, initial: 8 };
export const GLOW_RADIUS: Range = { min: 1, max: 200, initial: 24 };
export const GLOW_SOFTNESS: Range = { min: 0, max: 100, initial: 70 };
export const GLOW_OPACITY: Range = { min: 1, max: 100, initial: 80 };

/** A white sticker-style outline. */
export const OUTLINE_DEFAULTS: OutlineSettings = { color: "#ffffff", width: OUTLINE_WIDTH.initial };
/** A warm yellow glow, visible on the light and the dark checkerboard. */
export const GLOW_DEFAULTS: GlowSettings = {
  color: "#ffeb3b",
  radius: GLOW_RADIUS.initial,
  softness: GLOW_SOFTNESS.initial,
  opacity: GLOW_OPACITY.initial,
};

/** An effect as Rust takes it (src-tauri/src/editor/effects.rs `Effect`): fractions, not percent. */
export type Effect =
  | { readonly kind: "outline"; readonly color: string; readonly width: number }
  | {
      readonly kind: "glow";
      readonly color: string;
      readonly radius: number;
      readonly softness: number;
      readonly opacity: number;
    };

export function outlineEffect(s: OutlineSettings): Effect {
  return { kind: "outline", color: s.color, width: s.width };
}

export function glowEffect(s: GlowSettings): Effect {
  return { kind: "glow", color: s.color, radius: s.radius, softness: s.softness / 100, opacity: s.opacity / 100 };
}

/** What Rust draws: the layer's new pixels (grown past its old edge) and where they go. */
export interface EffectResult {
  readonly image: RgbaImage;
  readonly transform: Transform;
}

/** The layer an effect or the warp brush works on, or why there is none. */
export type Target = { readonly id: string } | { readonly blocker: string };

/** The one selected layer, else the base image (the bottom layer); null when several are selected. */
function targetId(doc: Doc, selection: readonly string[]): string | null {
  if (selection.length > 1) return null;
  return selection[0] ?? doc.layers[0].id;
}

/**
 * The layer an outline or glow goes on (SPEC §6): the selected layer, or
 * the base image when nothing is selected. Text layers qualify: Rust
 * rasterises them for the effect, so Apply turns them into image layers.
 */
export function effectTarget(doc: Doc, selection: readonly string[]): Target {
  const id = targetId(doc, selection);
  if (id === null) return { blocker: "Effects work on one layer at a time: select one layer (merge them first to treat them as one), or none for the base image." };
  return { id };
}

/**
 * The layer the warp/bulge brush paints on: the selected image layer, or
 * the base image when nothing is selected. Text is not warped (like Cut):
 * merge it into an image first.
 */
export function warpTarget(doc: Doc, selection: readonly string[]): Target {
  const id = targetId(doc, selection);
  if (id === null) return { blocker: "Warp paints on one layer at a time: select one layer, or none for the base image." };
  const layer = doc.layers[layerIndex(doc, id)];
  if (layer.kind === "text") return { blocker: "Text layers can't be warped: merge the text into an image layer first." };
  return { id };
}

/**
 * Bake an effect's result into the document: the layer gets the grown
 * pixels at their new transform and keeps its id, name and stack position.
 * A text layer becomes an image layer (its pixels now carry the effect).
 */
export function applyEffectResult(doc: Doc, id: string, result: EffectResult): Doc {
  const index = layerIndex(doc, id);
  const { name } = doc.layers[index];
  const baked: RasterLayer = { kind: "raster", id, name, transform: result.transform, image: result.image };
  const layers = doc.layers.slice();
  layers[index] = baked;
  return { ...doc, layers };
}

/** The neutral note after an effect turned a text layer into an image (as after Crop), else null. */
export function effectTextNotice(layer: Layer, kind: EffectKind): string | null {
  if (layer.kind !== "text") return null;
  return `The text layer was converted to an image for the ${kind}.`;
}

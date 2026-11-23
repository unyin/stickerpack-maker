// What the left button does on the canvas: the tool union, kept in the
// model so pure decisions can name it (effectKindOf, escDiscardsEffect)
// and a typo'd tool name stops compiling. The stage turns a tool into
// gestures; nothing here touches the DOM.
import type { BrushMode } from "./brush";

/**
 * What the left button does on the canvas: "move" moves the layer under
 * the pointer (or pans on empty space); "rect" drags the cut selection's
 * rectangle and "lasso" draws it from clicks and drags (SPM-9); "erase"
 * and "restore" paint the refine brush on the background tools' target
 * layer (SPM-7). In the effect tools "outline" and "glow" the canvas
 * selects nothing (the layer is chosen before the tool, owner decision
 * 2026-11-22) and nothing moves; empty space pans, and the target shows
 * its preview meanwhile. "warp" paints with the brush handed to
 * `onBrush` (SPM-8). None but "move" moves layers.
 */
export type CanvasTool = "move" | "rect" | "lasso" | "outline" | "glow" | "warp" | BrushMode;

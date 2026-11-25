// Single-key tool shortcuts (SPEC §6 Layout): V Move, R Rectangle, L Lasso,
// W Wand, E Erase, Shift+E Restore, B Warp, O Outline, G Glow, and T for the
// Text category (T is not a tool: the panel switches, no canvas gesture
// changes). The bindings are a changeable data-driven table — a rebinding UI
// is parked for v2 (SPEC §9) — so the view passes `TOOL_SHORTCUTS` (or its
// own copy) to the matcher.
//
// Pure decisions only: the CALLER owns the guard that shortcuts are live
// (no text field or typing overlay has focus), like Delete and Ctrl+Z today.
// `shortcutOf` maps an event to an action and applies the table's own rules:
//
// - Bare keys only: any Ctrl, Alt or Meta held returns null, so the modified
//   shortcuts (Ctrl+Z/Y/X/V/S, …) are unchanged.
// - Shift is part of a binding (E vs Shift+E), so a key with an unbound
//   Shift returns null rather than falling back to its bare binding.
// - Case is ignored when comparing letters and `shiftKey` alone decides the
//   Shift+E pair: CapsLock changes the letter's case but not `shiftKey`, so
//   it never changes which tool a key activates.
// - Auto-repeat keydowns are ignored: holding a key must not re-fire.
import type { CanvasTool } from "./tools";

/** What a bound key activates: a canvas tool, or the right panel's Text category. */
export type ShortcutAction = CanvasTool | "text-tab";

export interface ShortcutBinding {
  /** A single character, compared case-insensitively ("e" also matches "E"). */
  readonly key: string;
  /** Whether Shift must be held (the Shift+E pair). */
  readonly shift: boolean;
  readonly action: ShortcutAction;
}

/** The bindings of SPEC §6, in reading order. */
export const TOOL_SHORTCUTS: readonly ShortcutBinding[] = [
  { key: "v", shift: false, action: "move" },
  { key: "r", shift: false, action: "rect" },
  { key: "l", shift: false, action: "lasso" },
  { key: "w", shift: false, action: "wand" },
  { key: "e", shift: false, action: "erase" },
  { key: "e", shift: true, action: "restore" },
  { key: "b", shift: false, action: "warp" },
  { key: "o", shift: false, action: "outline" },
  { key: "g", shift: false, action: "glow" },
  { key: "t", shift: false, action: "text-tab" },
];

/**
 * The parts of a KeyboardEvent the matcher reads (a KeyboardEvent is
 * assignable), kept structural so the model stays DOM-free and testable.
 */
export interface ShortcutKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
}

/** The action a key event activates, or null when it is not a live shortcut. */
export function shortcutOf(
  event: ShortcutKeyEvent,
  table: readonly ShortcutBinding[] = TOOL_SHORTCUTS,
): ShortcutAction | null {
  if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return null;
  const key = event.key.toLowerCase();
  const binding = table.find((b) => b.key.toLowerCase() === key && b.shift === event.shiftKey);
  return binding?.action ?? null;
}

/** The binding's shortcut text for a tooltip ("V", "Shift+E"), or null when it has none. */
export function shortcutLabel(action: ShortcutAction, table: readonly ShortcutBinding[] = TOOL_SHORTCUTS): string | null {
  const binding = table.find((b) => b.action === action);
  if (!binding) return null;
  const letter = binding.key.toUpperCase();
  return binding.shift ? `Shift+${letter}` : letter;
}

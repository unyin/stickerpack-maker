// Tool shortcuts (SPEC §6 Layout, SPM-15): a changeable table and a pure
// matcher; the caller owns the focus guard, the matcher owns the modifiers.
import { expect, test } from "bun:test";
import {
  shortcutLabel,
  shortcutOf,
  TOOL_SHORTCUTS,
  type ShortcutBinding,
  type ShortcutKeyEvent,
} from "../src/editor/model/shortcuts";

/** A key event as the matcher reads it; unspecified modifiers are up. */
function key(key: string, shift = false, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return { key, shiftKey: shift, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...mods };
}

test("the table binds every tool of SPEC §6, plus the Text category", () => {
  expect(TOOL_SHORTCUTS).toEqual([
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
  ]);
  // Every canvas tool has exactly one bare binding; T is the only non-tool entry.
  expect(TOOL_SHORTCUTS.filter((b) => b.action === "text-tab").length).toBe(1);
  expect(new Set(TOOL_SHORTCUTS.map((b) => b.action)).size).toBe(TOOL_SHORTCUTS.length);
});

test("the bare letters select their tools, in either case", () => {
  expect(shortcutOf(key("v"))).toBe("move");
  expect(shortcutOf(key("r"))).toBe("rect");
  expect(shortcutOf(key("l"))).toBe("lasso");
  expect(shortcutOf(key("w"))).toBe("wand");
  expect(shortcutOf(key("e"))).toBe("erase");
  expect(shortcutOf(key("b"))).toBe("warp");
  expect(shortcutOf(key("o"))).toBe("outline");
  expect(shortcutOf(key("g"))).toBe("glow");
  expect(shortcutOf(key("t"))).toBe("text-tab");
  // CapsLock changes the letter's case but not shiftKey, so it never changes the tool.
  expect(shortcutOf(key("E"))).toBe("erase");
  expect(shortcutOf(key("G"))).toBe("glow");
  expect(shortcutOf(key("T"))).toBe("text-tab");
});

test("Shift+E restores; an unbound Shift returns nothing rather than the bare binding", () => {
  expect(shortcutOf(key("E", true))).toBe("restore");
  // With CapsLock on, Shift inverts the letter's case (key "e"): shiftKey still decides.
  expect(shortcutOf(key("e", true))).toBe("restore");
  for (const letter of ["v", "r", "l", "w", "b", "o", "g", "t"]) expect(shortcutOf(key(letter, true))).toBeNull();
});

test("any Ctrl, Alt or Meta held leaves the modified shortcuts alone", () => {
  expect(shortcutOf(key("v", false, { ctrlKey: true }))).toBeNull(); // Ctrl+V pastes
  expect(shortcutOf(key("e", true, { ctrlKey: true }))).toBeNull();
  expect(shortcutOf(key("s", false, { ctrlKey: true }))).toBeNull();
  expect(shortcutOf(key("v", false, { altKey: true }))).toBeNull();
  expect(shortcutOf(key("v", false, { metaKey: true }))).toBeNull();
});

test("auto-repeat, unknown keys and non-letter keys activate nothing", () => {
  expect(shortcutOf(key("v", false, { repeat: true }))).toBeNull();
  expect(shortcutOf(key("x"))).toBeNull();
  expect(shortcutOf(key("Shift"))).toBeNull();
  expect(shortcutOf(key("1"))).toBeNull();
  expect(shortcutOf(key(""))).toBeNull();
});

test("the table is changeable: a caller's own bindings are honoured", () => {
  const table: ShortcutBinding[] = [
    { key: "a", shift: false, action: "move" },
    { key: "q", shift: true, action: "glow" },
  ];
  expect(shortcutOf(key("v"), table)).toBeNull();
  expect(shortcutOf(key("a"), table)).toBe("move");
  expect(shortcutOf(key("Q", true), table)).toBe("glow");
  expect(shortcutLabel("move", table)).toBe("A");
  expect(shortcutLabel("restore", table)).toBeNull();
});

test("shortcutLabel spells the tooltip's shortcut text", () => {
  expect(shortcutLabel("move")).toBe("V");
  expect(shortcutLabel("erase")).toBe("E");
  expect(shortcutLabel("restore")).toBe("Shift+E");
  expect(shortcutLabel("text-tab")).toBe("T");
});

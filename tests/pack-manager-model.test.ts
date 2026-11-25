// Pure rules behind the Pack Manager (SPEC §5): selection, modes, reorder
// hit-testing, the Emoji String warning, and user-facing wording.
import { expect, test } from "bun:test";
import limits from "../src/shared/limits.json";
import { editorCanImport } from "../src/shared/import-extensions";
import { KB } from "../src/shared/units";
import type { StickerView } from "../src/pack-manager/api";
import { charCount, rustTrim, shortNameProblem, titleProblem } from "../src/pack-manager/model/names";
import { EMOJI_MAX, emojiCount, emojiCountWarning, emojiWarning } from "../src/pack-manager/model/emoji";
import {
  combinedSize,
  GO_LIVE_CONFIRMATION,
  formatBytes,
  importSummary,
  REVERT_TO_DRAFT_WARNING,
  matchPacks,
  MISSING_REASON,
  countWarningText,
  packCountText,
  packDeleteMessage,
  packSizeText,
  sendBlocker,
  sendReportText,
  thumbnailFormat,
} from "../src/pack-manager/model/messages";
import { dropPosition, escapeAction, rowSlotAt, selectionActive, slotAt, toggleMode } from "../src/pack-manager/model/modes";
import { importOrder } from "../src/pack-manager/model/import-order";
import { defaultPackId, initialFocus } from "../src/pack-manager/model/pack-memory";
import {
  clickSticker,
  clickThumbnail,
  modifiersOf,
  NO_SELECTION,
  panelFor,
  pruneSelection,
} from "../src/pack-manager/model/selection";

const order = [10, 11, 12, 13, 14];
const plain = { ctrl: false, shift: false };
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };

test("click selects one sticker, replacing any selection", () => {
  let s = clickSticker(NO_SELECTION, order, 11, plain);
  expect(s.ids).toEqual([11]);
  s = clickSticker(s, order, 13, plain);
  expect(s).toEqual({ ids: [13], thumbnail: false, anchor: 13 });
  expect(panelFor(s)).toBe("detail");
});

test("ctrl+click toggles in and out, keeping pack order", () => {
  let s = clickSticker(NO_SELECTION, order, 13, plain);
  s = clickSticker(s, order, 10, ctrl);
  expect(s.ids).toEqual([10, 13]);
  expect(panelFor(s)).toBe("aggregate");
  s = clickSticker(s, order, 13, ctrl);
  expect(s.ids).toEqual([10]);
  s = clickSticker(s, order, 10, ctrl);
  expect(s.ids).toEqual([]);
  expect(panelFor(s)).toBe("none");
});

test("shift+click selects the range from the anchor, either direction", () => {
  let s = clickSticker(NO_SELECTION, order, 11, plain);
  s = clickSticker(s, order, 13, shift);
  expect(s.ids).toEqual([11, 12, 13]);
  // The anchor stays, so a second shift+click re-ranges from it.
  s = clickSticker(s, order, 10, shift);
  expect(s.ids).toEqual([10, 11]);
  // Without an anchor, shift+click is a plain click.
  expect(clickSticker(NO_SELECTION, order, 12, shift).ids).toEqual([12]);
  // Ctrl+click moves the anchor.
  s = clickSticker(clickSticker(NO_SELECTION, order, 10, plain), order, 14, ctrl);
  expect(clickSticker(s, order, 12, shift).ids).toEqual([12, 13, 14]);
});

test("the thumbnail is selected alone and never joins a sticker selection", () => {
  const s = clickThumbnail();
  expect(panelFor(s)).toBe("thumbnail");
  const next = clickSticker(s, order, 12, ctrl);
  expect(next).toEqual({ ids: [12], thumbnail: false, anchor: 12 });
  expect(clickSticker(s, order, 12, shift).thumbnail).toBe(false);
});

test("pruning drops stickers that left the pack and reorders to pack order", () => {
  const s = { ids: [12, 10, 99], thumbnail: false, anchor: 99 };
  expect(pruneSelection(s, order)).toEqual({ ids: [10, 12], thumbnail: false, anchor: null });
  expect(clickSticker(s, order, 999, plain)).toBe(s);
});

test("cmd counts as ctrl", () => {
  expect(modifiersOf({ ctrlKey: false, metaKey: true, shiftKey: false })).toEqual(ctrl);
});

test("modes are exclusive; Esc leaves Reorder or clears the selection", () => {
  expect(toggleMode("normal")).toBe("reorder");
  expect(toggleMode("reorder")).toBe("normal");
  expect(escapeAction("reorder")).toBe("exit-reorder");
  expect(escapeAction("normal")).toBe("clear-selection");
  expect(selectionActive("normal")).toBe(true);
  expect(selectionActive("reorder")).toBe(false);
});

test("a drop slot maps to the moved sticker's new position", () => {
  // Four stickers; moving the first.
  expect(dropPosition(0, 0)).toBeNull();
  expect(dropPosition(0, 1)).toBeNull();
  expect(dropPosition(0, 2)).toBe(2);
  expect(dropPosition(0, 4)).toBe(4);
  // Moving the last one to the front.
  expect(dropPosition(3, 0)).toBe(1);
  expect(dropPosition(3, 4)).toBeNull();
  expect(dropPosition(2, 1)).toBe(2);
});

test("the slot under the pointer follows the nearest tile's halves", () => {
  // Two rows of two 100px tiles with 10px gaps.
  const tiles = [
    { left: 0, top: 0, width: 100, height: 100 },
    { left: 110, top: 0, width: 100, height: 100 },
    { left: 0, top: 110, width: 100, height: 100 },
    { left: 110, top: 110, width: 100, height: 100 },
  ];
  expect(slotAt(tiles, 10, 50)).toBe(0);
  expect(slotAt(tiles, 90, 50)).toBe(1);
  expect(slotAt(tiles, 120, 50)).toBe(1);
  expect(slotAt(tiles, 200, 150)).toBe(4);
  expect(slotAt(tiles, 400, 400)).toBe(4); // far past the end
  expect(slotAt(tiles, -50, 150)).toBe(2); // left of the second row
  expect(slotAt([], 5, 5)).toBe(0);
});

test("emoji are counted as people see them, and warn outside 1-20", () => {
  expect(EMOJI_MAX).toBe(limits.emojiString.maxEmoji);
  expect(emojiCount("😀👍🏽👨‍👩‍👧🇫🇷")).toBe(4);
  expect(emojiCount(" 😀 ")).toBe(1);
  expect(emojiWarning("")).toContain("No emoji");
  expect(emojiWarning("😀")).toBeNull();
  expect(emojiWarning("😀".repeat(EMOJI_MAX))).toBeNull();
  expect(emojiWarning("😀".repeat(EMOJI_MAX + 1))).toContain(`at most ${EMOJI_MAX}`);
  // Same shape the core reports in the pack view.
  expect(emojiCountWarning("")).toEqual({ kind: "emojiCount", count: 0 });
  expect(emojiCountWarning("😀😀")).toBeNull();
  expect(emojiCountWarning("😀".repeat(EMOJI_MAX + 1))).toEqual({ kind: "emojiCount", count: EMOJI_MAX + 1 });
});

test("pack deletion wording depends on Draft or Live", () => {
  expect(packDeleteMessage("Cats", "draft", 3)).toContain("permanently deleted");
  const live = packDeleteMessage("Cats", "live", 1);
  expect(live).toContain("stays on Telegram");
  expect(live).toContain("@Stickers");
  expect(live).toContain("1 sticker");
});

test("the size banner appears only above the pack cap", () => {
  const cap = limits.pack.maxStickers;
  expect(packSizeText(cap)).toBeNull();
  expect(packSizeText(cap + 2)).toContain(`at most ${cap}`);
});

function sticker(id: number, missing: boolean, bytes = 2048): StickerView {
  return {
    id,
    packId: 1,
    position: id,
    fileName: `00${id}.png`,
    format: "png",
    emojiString: "",
    missing,
    emojiWarning: null,
    file: missing ? null : { bytes, width: 512, height: 512 },
  };
}

test("Missing stickers block Send to pack with a reason", () => {
  expect(sendBlocker([sticker(1, false)])).toBeNull();
  expect(sendBlocker([sticker(1, true)])).toBe(MISSING_REASON);
  expect(sendBlocker([sticker(1, true), sticker(2, false)])).toContain("1 of the selected stickers is Missing");
});

test("combined size sums present files and counts Missing ones", () => {
  expect(combinedSize([sticker(1, false), sticker(2, false)])).toBe("4.0 KB");
  expect(combinedSize([sticker(1, false), sticker(2, true)])).toBe("2.0 KB (1 Missing)");
  expect(formatBytes(10)).toBe("10 bytes");
  expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
});

test("import and send reports say what happened", () => {
  expect(importSummary(2, 0)).toContain("Added 2 stickers without emoji");
  expect(importSummary(0, 1)).toContain(`1 file is not a valid sticker`);
  expect(importSummary(0, 1)).toContain(`${limits.sticker.side} px`);
  expect(importSummary(0, 2)).toContain(`2 files are not valid stickers`);
  expect(countWarningText(null, 0)).toBeNull();
  expect(countWarningText(null, 2)).toBe("2 Missing.");
  expect(countWarningText(packSizeText(125), 0)).toBe(packSizeText(125));
  expect(countWarningText(packSizeText(125), 2)).toBe(`${packSizeText(125)} 2 Missing.`);
  const report = { copied: [], originalsDeleted: true, unfinished: "x", targetSizeWarning: null };
  expect(sendReportText(report, "Dogs")).toContain("Moved 0 stickers to “Dogs”. Not finished: x.");
});

test("the pack picker searches Titles first, then Titles or Short Names", () => {
  const pack = { title: "Happy Cats", shortName: "happy_cats" };
  expect(matchPacks([pack], "")).toEqual([pack]);
  expect(matchPacks([pack], "CATS")).toEqual([pack]);
  expect(matchPacks([pack], "y_c")).toEqual([pack]);
  expect(matchPacks([pack], "dogs")).toEqual([]);
  // Titles starting with the query come first, then Titles or Short Names containing it.
  const a = { title: "Best cats", shortName: "best" };
  const b = { title: "Cats two", shortName: "two" };
  const c = { title: "Misc", shortName: "old_cats" };
  expect(matchPacks([a, c, b], "cat")).toEqual([b, a, c]);
});

test("Open in editor is offered only for files the Editor can import", () => {
  for (const ok of ["C:\\a\\cat.JPG", "x.jpeg", "x.jfif", "/p/x.PNG", "x.webp"]) expect(editorCanImport(ok)).toBe(true);
  for (const no of ["notes.txt", "x.gif", "x.png.bak", "noextension", "dir.png/file"]) expect(editorCanImport(no)).toBe(false);
});

test("the target pack over the cap is worded for the target; the thumbnail format follows its name", () => {
  const cap = limits.pack.maxStickers;
  expect(packSizeText(cap + 1, "The target pack")).toStartWith(`The target pack has ${cap + 1} stickers`);
  expect(packSizeText(cap + 1)).toStartWith("This pack has");
  expect(thumbnailFormat("thumbnail.webp")).toBe("webp");
  expect(thumbnailFormat("thumbnail.png")).toBe("png");
  expect(thumbnailFormat(null)).toBe("png");
  expect(formatBytes(KB)).toBe("1.0 KB");
  expect(limits.pack.titleMaxChars).toBeGreaterThan(0);
});

test("Title and Short Name limits count characters like the core, not UTF-16 units", () => {
  const t = limits.pack.titleMaxChars;
  const s = limits.pack.shortNameMaxChars;
  expect(charCount("😀")).toBe(1);
  expect("😀".length).toBe(2);
  expect(titleProblem("😀".repeat(t))).toBeNull();
  expect(titleProblem("😀".repeat(t + 1))).not.toBeNull();
  expect(titleProblem("x".repeat(t))).toBeNull();
  expect(titleProblem("x".repeat(t + 1))).not.toBeNull();
  expect(titleProblem("   ")).not.toBeNull();
  expect(titleProblem(` ${"x".repeat(t)} `)).toBeNull(); // trimmed first, like the core
  expect(shortNameProblem("")).toBeNull(); // empty = auto-derive
  expect(shortNameProblem("x".repeat(s))).toBeNull();
  expect(shortNameProblem("x".repeat(s + 1))).not.toBeNull();
  expect(shortNameProblem("😀".repeat(s))).toBeNull(); // the core rejects it as a slug, not as too long
});

test("an empty Short Name is fine when creating (auto-derive) but invalid in the pack header", () => {
  expect(shortNameProblem("")).toBeNull();
  expect(shortNameProblem("   ")).toBeNull();
  expect(shortNameProblem("", { allowEmpty: true })).toBeNull();
  expect(shortNameProblem("", { allowEmpty: false })).not.toBeNull();
  expect(shortNameProblem("  \u0085 ", { allowEmpty: false })).not.toBeNull();
  expect(shortNameProblem("abc", { allowEmpty: false })).toBeNull();
});

test("names trim like Rust str::trim, not like JS trim", () => {
  expect(titleProblem("\uFEFF")).toBeNull(); // Rust keeps U+FEFF, so the core accepts it
  expect(titleProblem("\u0085")).not.toBeNull(); // Rust strips U+0085
  expect(titleProblem("   ")).not.toBeNull();
  expect(rustTrim("  a b \t\n")).toBe("a b");
  expect(rustTrim("\u0085a\u0085")).toBe("a");
  expect(rustTrim("\uFEFFa")).toBe("\uFEFFa");
});

test("the status toggle is confirmed both ways, and each text names the Short Name lock (SPEC §3)", () => {
  expect(GO_LIVE_CONFIRMATION).toContain("Going Live locks the Short Name");
  expect(GO_LIVE_CONFIRMATION).toContain("exists on Telegram");
  expect(REVERT_TO_DRAFT_WARNING).toContain("unlocks the Short Name");
  expect(GO_LIVE_CONFIRMATION).not.toBe(REVERT_TO_DRAFT_WARNING);
});

test("importOrder: natural filename order whatever order Windows hands the files over", () => {
  const dropped = ["C:\\in\\sticker10.png", "C:\\in\\sticker2.png", "C:\\in\\Sticker1.webp", "C:\\in\\a.png"];
  expect(importOrder(dropped)).toEqual(["C:\\in\\a.png", "C:\\in\\Sticker1.webp", "C:\\in\\sticker2.png", "C:\\in\\sticker10.png"]);
});

test("importOrder: sorts by file name, not by folder", () => {
  expect(importOrder(["C:\\z\\01.png", "C:\\a\\02.png"])).toEqual(["C:\\z\\01.png", "C:\\a\\02.png"]);
});

test("importOrder: leaves the input untouched", () => {
  const input = ["b.png", "a.png"];
  importOrder(input);
  expect(input).toEqual(["b.png", "a.png"]);
});

test("packCountText: singular and plural", () => {
  expect(packCountText(0)).toBe("0 packs");
  expect(packCountText(1)).toBe("1 pack");
  expect(packCountText(12)).toBe("12 packs");
});

test("pack pickers start on the open pack, else the last pack saved into, else none", () => {
  expect(defaultPackId([1, 2, 3], { openPackId: 2, lastSavedPackId: 3 })).toBe(2);
  // Send to pack does not list the pack it sends from: the last saved pack instead.
  expect(defaultPackId([1, 3], { openPackId: 2, lastSavedPackId: 3 })).toBe(3);
  expect(defaultPackId([1, 3], { openPackId: null, lastSavedPackId: 3 })).toBe(3);
  // A remembered pack that is gone (deleted, another Library) is skipped.
  expect(defaultPackId([1], { openPackId: 2, lastSavedPackId: 3 })).toBeNull();
  expect(defaultPackId([], { openPackId: null, lastSavedPackId: null })).toBeNull();
});

test("Save focuses its button when a pack is chosen; Send to pack always starts in the pack field", () => {
  expect(initialFocus("save", true)).toBe("submit");
  expect(initialFocus("save", false)).toBe("picker");
  // Enter must never send to a remembered pack at once (owner decision 2026-11-22).
  expect(initialFocus("send", true)).toBe("picker");
  expect(initialFocus("send", false)).toBe("picker");
});

test("rowSlotAt: before a row above its middle, after it below, ends clamp", () => {
  const rows = [0, 1, 2].map((i) => ({ left: 0, top: i * 50, width: 400, height: 40 })); // gaps of 10
  expect(rowSlotAt(rows, -30)).toBe(0);
  expect(rowSlotAt(rows, 10)).toBe(0);
  expect(rowSlotAt(rows, 30)).toBe(1); // below row 0's middle (20)
  expect(rowSlotAt(rows, 45)).toBe(1); // in the gap
  expect(rowSlotAt(rows, 80)).toBe(2);
  expect(rowSlotAt(rows, 130)).toBe(3);
  expect(rowSlotAt(rows, 9999)).toBe(3);
  expect(rowSlotAt([], 5)).toBe(0);
});

import { packsAlphabetical, rowClickOpens } from "../src/pack-manager/model/pack-row";

test("a click opens the pack unless it hit a control or ends a drag", () => {
  expect(rowClickOpens({ onControl: false, endsDrag: false })).toBe(true);
  expect(rowClickOpens({ onControl: true, endsDrag: false })).toBe(false);
  expect(rowClickOpens({ onControl: false, endsDrag: true })).toBe(false);
  expect(rowClickOpens({ onControl: true, endsDrag: true })).toBe(false);
});

test("pickers list packs alphabetically: case-insensitive, natural numbers, stable ties", () => {
  const p = (id: number, title: string, shortName = `s${id}`) => ({ id, title, shortName });
  const sorted = packsAlphabetical([p(1, "pack 10"), p(2, "Pack 2"), p(3, "banana"), p(4, "Apple"), p(5, "apple", "a"), p(6, "APPLE", "a")]);
  expect(sorted.map((x) => x.id)).toEqual([5, 6, 4, 3, 2, 1]);
  const input = [p(2, "b"), p(1, "a")];
  packsAlphabetical(input);
  expect(input.map((x) => x.id)).toEqual([2, 1]);
});

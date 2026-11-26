// The top bar's pure decisions (SPM-26).
import { expect, test } from "bun:test";
import { backButtonState, packTabLabel, tabClickAction } from "../src/shell-model";
import { changed, NO_PACK_MANAGER, type PackManagerState } from "../src/pack-manager/model/shell-state";

const open: PackManagerState = { open: { id: 7, title: "Cat Moods" }, busy: false };
const busy: PackManagerState = { open: open.open, busy: true };

test("the tab is plain with no pack open, on every screen", () => {
  for (const screen of ["editor", "pack-manager", "settings"] as const) {
    expect(packTabLabel(screen, null)).toEqual({ packTitle: null, tooltip: null });
  }
});

test("the tab names the open pack on every screen", () => {
  for (const screen of ["editor", "pack-manager", "settings"] as const) {
    expect(packTabLabel(screen, open.open).packTitle).toBe("Cat Moods");
  }
});

test("the tooltip: back to the pack from elsewhere, back to the list while the pack is on screen", () => {
  expect(packTabLabel("editor", open.open).tooltip).toBe("Back to “Cat Moods”");
  expect(packTabLabel("settings", open.open).tooltip).toBe("Back to “Cat Moods”");
  expect(packTabLabel("pack-manager", open.open).tooltip).toBe("Back to the list of packs");
});

test("the tooltip carries the full Title (the tab only shows it capped)", () => {
  const long = "x".repeat(80);
  expect(packTabLabel("editor", { id: 1, title: long }).tooltip).toBe(`Back to “${long}”`);
});

test("a tab click shows its screen, except the Pack Manager tab while the pack is on screen", () => {
  expect(tabClickAction("editor", "pack-manager", open)).toBe("show");
  expect(tabClickAction("settings", "pack-manager", open)).toBe("show");
  expect(tabClickAction("pack-manager", "editor", open)).toBe("show");
  expect(tabClickAction("pack-manager", "settings", open)).toBe("show");
  expect(tabClickAction("pack-manager", "pack-manager", open)).toBe("list");
});

test("on the Pack list the Pack Manager tab still shows (reloads) it", () => {
  expect(tabClickAction("pack-manager", "pack-manager", NO_PACK_MANAGER)).toBe("show");
});

test("a busy pack view blocks the tab's go-to-list, but not leaving or returning", () => {
  expect(tabClickAction("pack-manager", "pack-manager", busy)).toBe("none");
  expect(tabClickAction("editor", "pack-manager", busy)).toBe("show");
  expect(tabClickAction("pack-manager", "editor", busy)).toBe("show");
});

test("the back button shows only while the Pack Manager shows a pack, disabled while busy", () => {
  expect(backButtonState("pack-manager", open)).toEqual({ visible: true, disabled: false });
  expect(backButtonState("pack-manager", busy)).toEqual({ visible: true, disabled: true });
  expect(backButtonState("pack-manager", NO_PACK_MANAGER).visible).toBe(false);
  expect(backButtonState("editor", open).visible).toBe(false);
  expect(backButtonState("settings", open).visible).toBe(false);
});

test("the back button is not disabled while hidden, even if the pack reports busy", () => {
  expect(backButtonState("editor", busy)).toEqual({ visible: false, disabled: false });
  expect(backButtonState("settings", busy)).toEqual({ visible: false, disabled: false });
  expect(backButtonState("pack-manager", { open: null, busy: true })).toEqual({ visible: false, disabled: false });
});

test("a published state counts as changed only when the pack, its Title or busy differ", () => {
  expect(changed(open, { open: { id: 7, title: "Cat Moods" }, busy: false })).toBe(false);
  expect(changed(NO_PACK_MANAGER, NO_PACK_MANAGER)).toBe(false);
  expect(changed(open, busy)).toBe(true);
  expect(changed(open, { open: { id: 7, title: "Cats" }, busy: false })).toBe(true);
  expect(changed(open, { open: { id: 8, title: "Cat Moods" }, busy: false })).toBe(true);
  expect(changed(open, NO_PACK_MANAGER)).toBe(true);
  expect(changed(NO_PACK_MANAGER, open)).toBe(true);
});

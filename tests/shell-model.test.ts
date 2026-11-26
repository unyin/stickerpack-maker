// The top bar's pure decisions (SPM-26).
import { expect, test } from "bun:test";
import {
  backButtonState,
  mouseBackGoesToList,
  NO_PACK_MANAGER,
  packTabLabel,
  tabClickAction,
  type PackManagerState,
} from "../src/shell-model";

const open: PackManagerState = { open: { id: 7, title: "Cat Moods" }, busy: false };
const busy: PackManagerState = { open: open.open, busy: true };

test("the tab is plain with no pack open, on every screen", () => {
  for (const screen of ["editor", "pack-manager", "settings"] as const) {
    expect(packTabLabel(screen, null)).toEqual({ label: "Pack Manager", packTitle: null, tooltip: null });
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

test("the mouse back button goes to the list only where the back button works", () => {
  expect(mouseBackGoesToList(3, "pack-manager", open)).toBe(true);
  expect(mouseBackGoesToList(3, "pack-manager", busy)).toBe(false);
  expect(mouseBackGoesToList(3, "pack-manager", NO_PACK_MANAGER)).toBe(false);
  expect(mouseBackGoesToList(3, "editor", open)).toBe(false);
  expect(mouseBackGoesToList(0, "pack-manager", open)).toBe(false);
  expect(mouseBackGoesToList(4, "pack-manager", open)).toBe(false);
});

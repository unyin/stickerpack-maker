import { describe, expect, test } from "bun:test";
import {
  addedMessage,
  asStickerMessage,
  cancelledIgnoredMessage,
  cantOpenMessage,
  dropDialogBody,
  dropDialogButtons,
  dropPlan,
  openedMessage,
} from "../src/editor/model/drop";

describe("dropPlan", () => {
  test("a dialog open, or no paths, ignores the drop", () => {
    expect(dropPlan(["C:\\a.png"], "none", false, true)).toEqual({ kind: "ignore" });
    expect(dropPlan(["C:\\a.png"], "sticker", true, true)).toEqual({ kind: "ignore" });
    expect(dropPlan([], "none", false, false)).toEqual({ kind: "ignore" });
  });
  test("busy refuses, whatever is open", () => {
    for (const s of ["none", "sticker", "thumbnail"] as const) expect(dropPlan(["C:\\a.png"], s, true, false)).toEqual({ kind: "busy" });
  });
  test("nothing open opens the first file", () => {
    expect(dropPlan(["C:\\x\\a.png"], "none", false, false)).toEqual({ kind: "open", path: "C:\\x\\a.png", name: "a.png", more: false });
    expect(dropPlan(["C:\\a.png", "C:\\b.gif"], "none", false, false)).toMatchObject({ kind: "open", name: "a.png", more: true });
  });
  test("an image open asks, in thumbnail mode with the thumbnail flag", () => {
    expect(dropPlan(["/p/b.PNG"], "sticker", false, false)).toEqual({ kind: "ask", path: "/p/b.PNG", name: "b.PNG", more: false, thumbnail: false });
    expect(dropPlan(["/p/b.webp", "/p/c.png"], "thumbnail", false, false)).toMatchObject({ kind: "ask", more: true, thumbnail: true });
  });
  test("an unsupported first file stops everything, later files are not tried", () => {
    expect(dropPlan(["C:\\x.gif"], "none", false, false)).toEqual({ kind: "unsupported", name: "x.gif", more: false });
    expect(dropPlan(["C:\\x.gif", "C:\\b.png"], "sticker", false, false)).toEqual({ kind: "unsupported", name: "x.gif", more: true });
  });
  test("folders and extensionless names are unsupported; extensions are case-insensitive", () => {
    expect(dropPlan(["C:\\Pictures\\folder"], "none", false, false).kind).toBe("unsupported");
    for (const n of ["a.JPG", "a.Jpeg", "a.JFIF", "a.png", "a.WebP"]) expect(dropPlan([n], "none", false, false).kind).toBe("open");
  });
});

describe("drop messages", () => {
  test("can't open, with and without the tail", () => {
    expect(cantOpenMessage("x.gif", false)).toBe("Can't open “x.gif”: the Editor opens PNG, JPEG and WEBP files.");
    expect(cantOpenMessage("x.gif", true)).toBe("Can't open “x.gif”: the Editor opens PNG, JPEG and WEBP files. Dropped files after the first are ignored.");
  });
  test("opened, added, as a sticker", () => {
    expect(openedMessage("a.png", false)).toBe("Opened “a.png”.");
    expect(openedMessage("a.png", true)).toBe("Opened “a.png”; dropped files after the first are ignored.");
    expect(addedMessage("b.png", false)).toBe("Added “b.png” as a layer.");
    expect(addedMessage("b.png", true)).toBe("Added “b.png” as a layer; dropped files after the first are ignored.");
    expect(asStickerMessage("b.png", false)).toBe("Opened “b.png” as a sticker.");
    expect(asStickerMessage("b.png", true)).toBe("Opened “b.png” as a sticker; dropped files after the first are ignored.");
  });
  test("cancel note only with several files", () => {
    expect(cancelledIgnoredMessage(true)).toBe("Dropped files after the first were ignored.");
    expect(cancelledIgnoredMessage(false)).toBe("");
  });
});

describe("drop dialog", () => {
  test("sticker session: one body line, plain labels, Cancel primary and last", () => {
    expect(dropDialogBody("b.png", false, "")).toEqual([{ text: "What should happen to “b.png”?", muted: false }]);
    const b = dropDialogButtons(false);
    expect(b.map((x) => x.label)).toEqual(["Add as layer", "Open instead", "Cancel"]);
    expect(b.map((x) => x.variant)).toEqual(["secondary", "secondary", "primary"]);
  });
  test("thumbnail session: muted second line and the longer label", () => {
    expect(dropDialogBody("b.png", true, "Cats")).toEqual([
      { text: "What should happen to “b.png”?", muted: false },
      { text: "Open instead starts a new sticker, not a thumbnail for “Cats”.", muted: true },
    ]);
    expect(dropDialogButtons(true).map((x) => x.label)).toEqual(["Add as layer", "Open as sticker instead", "Cancel"]);
  });
});

// The save pipeline's rules and wording (src/editor/save.ts, SPM-10):
// when Save is blocked, the owner's size flow, and the messages.
import { expect, test } from "bun:test";
import limits from "../src/shared/limits.json";
import { KB } from "../src/shared/units";
import { STICKER, THUMBNAIL } from "../src/editor/model/constraints";
import {
  declinedText,
  exhaustedText,
  originAfterSave,
  originGoneCloseWarning,
  pngTooLargeText,
  replaceLabel,
  resolveOrigin,
  saveRefusal,
  showStickerLink,
  stickerGoneText,
  runSave,
  saveBlocker,
  savedText,
  SAVE_MID_STROKE,
  type SaveFormat,
  type SaveOutcome,
  type TooLarge,
} from "../src/editor/save";

const S = limits.sticker.side;
const T = limits.thumbnail.side;

test("Sticker mode saves only with the longest side exactly the sticker side", () => {
  expect(saveBlocker({ width: S, height: S }, STICKER)).toBeNull();
  expect(saveBlocker({ width: S, height: 1 }, STICKER)).toBeNull();
  expect(saveBlocker({ width: 1, height: S }, STICKER)).toBeNull();
  const over = saveBlocker({ width: S + 88, height: 400 }, STICKER);
  expect(over).toContain("Save is blocked");
  expect(over).toContain("88 px over");
  expect(over).toContain(`Fit to ${S}×${S} or Longest side ${S}`);
  expect(saveBlocker({ width: S - 1, height: S - 1 }, STICKER)).toContain("1 px under");
});

test("a save attempted mid-brush-stroke is refused and never reaches the dialog; after the stroke ends it proceeds", () => {
  // The seam both save entry points (Save…, Ctrl+S) go through (SPM-7): a
  // mid-press stroke's pixels are painted live but not in the model yet, so
  // even a canvas that passes the rule is refused before the dialog could
  // open on a snapshot without them.
  const canvas = { width: S, height: S };
  expect(saveRefusal(true, canvas, STICKER)).toBe(SAVE_MID_STROKE);
  expect(SAVE_MID_STROKE).toStartWith("Save is blocked:");
  expect(SAVE_MID_STROKE).toContain("operation");
  expect(SAVE_MID_STROKE).toContain("first");
  // After the release only the canvas rule decides again, and it passes.
  expect(saveRefusal(false, canvas, STICKER)).toBeNull();
});

test("a save attempted mid-warp-drag is refused and never reaches the dialog; after the release it proceeds", () => {
  // The same seam as a brush stroke, now covering SPM-8: a warp press lives
  // in the stage's brushing flag, its bulge previewed live but committed to
  // the model only at release, so even a canvas that passes the rule is
  // refused before the dialog could open on a snapshot without it.
  const canvas = { width: S, height: S };
  expect(saveRefusal(true, canvas, STICKER)).toBe(SAVE_MID_STROKE);
  expect(SAVE_MID_STROKE).toContain("Warp");
  expect(SAVE_MID_STROKE).not.toContain("stroke");
  // After the release only the canvas rule decides again, and it passes.
  expect(saveRefusal(false, canvas, STICKER)).toBeNull();
});

test("Thumbnail mode saves only exactly square, and only Fit is offered as the fix", () => {
  expect(saveBlocker({ width: T, height: T }, THUMBNAIL)).toBeNull();
  const off = saveBlocker({ width: T, height: T + 2 }, THUMBNAIL)!;
  expect(off).toContain("height 2 px over");
  expect(off).toContain(`Fit to ${T}×${T} fixes it`);
  expect(off).not.toContain("Longest side");
});

const sticker = { id: 9, packId: 2, position: 4, fileName: "004.png", format: "png" as const, emojiString: "" };
const saved = (format: SaveFormat): SaveOutcome => ({
  kind: "saved",
  sticker: { ...sticker, format, fileName: `004.${format}` },
  bytes: 2048,
  quality: format === "webp" ? 80 : null,
});
const tooLarge = (format: SaveFormat): TooLarge => ({ kind: "tooLarge", format, bytes: (limits.sticker.maxKilobytes + 88) * KB, maxKilobytes: limits.sticker.maxKilobytes });

/** A scripted flow: what each save returns, and the user's answer to the WEBP offer. */
function flow(outcomes: Partial<Record<SaveFormat, SaveOutcome>>, accept: boolean) {
  const log: string[] = [];
  return {
    log,
    flow: {
      save: async (f: SaveFormat) => {
        log.push(`save ${f}`);
        return outcomes[f]!;
      },
      offerWebp: async () => {
        log.push("offer");
        return accept;
      },
    },
  };
}

test("a save that fits is saved in the chosen format, with no question", async () => {
  for (const f of ["png", "webp"] as const) {
    const { log, flow: fl } = flow({ [f]: saved(f) }, false);
    const result = await runSave(f, fl);
    expect(result).toEqual({ kind: "saved", outcome: saved(f) as never });
    expect(log).toEqual([`save ${f}`]);
  }
});

test("a PNG over the cap offers WEBP, and saves as WEBP when accepted", async () => {
  const { log, flow: fl } = flow({ png: tooLarge("png"), webp: saved("webp") }, true);
  expect((await runSave("png", fl)).kind).toBe("saved");
  expect(log).toEqual(["save png", "offer", "save webp"]);
});

test("a PNG over the cap with the offer declined saves nothing", async () => {
  const { log, flow: fl } = flow({ png: tooLarge("png") }, false);
  expect(await runSave("png", fl)).toEqual({ kind: "declined", outcome: tooLarge("png") });
  expect(log).toEqual(["save png", "offer"]);
});

test("a WEBP over the cap even at the lowest quality is exhausted, chosen or offered", async () => {
  const direct = flow({ webp: tooLarge("webp") }, true);
  expect((await runSave("webp", direct.flow)).kind).toBe("exhausted");
  expect(direct.log).toEqual(["save webp"]);
  const offered = flow({ png: tooLarge("png"), webp: tooLarge("webp") }, true);
  expect(await runSave("png", offered.flow)).toEqual({ kind: "exhausted", outcome: tooLarge("webp") });
});

test("errors from the save reject the flow", async () => {
  const fl = { save: async () => Promise.reject("Not saved: bad size."), offerWebp: async () => true };
  await expect(runSave("png", fl)).rejects.toBe("Not saved: bad size.");
});

test("the size messages say how large and what the limit is", () => {
  const cap = `${limits.sticker.maxKilobytes} KB limit`;
  expect(pngTooLargeText(tooLarge("png")).join(" ")).toContain(`${limits.sticker.maxKilobytes + 88}.0 KB, over the ${cap}`);
  expect(pngTooLargeText(tooLarge("png")).join(" ")).toContain("WEBP");
  expect(declinedText(tooLarge("png"))).toStartWith("Not saved:");
  expect(exhaustedText(limits.sticker.maxKilobytes)).toBe(
    "Congratulations, you've somehow managed to make an image so weird that even WEBP at its lowest " +
      `quality won't save below ${limits.sticker.maxKilobytes} KB. Go back to the editor and try to fix it, ` +
      "or fuck it all and start over. Up to you.",
  );
  expect(exhaustedText(limits.thumbnail.maxKilobytes)).toContain(`below ${limits.thumbnail.maxKilobytes} KB.`);
});

test("the saved note names the file, the slot, the pack and the size", () => {
  const out = saved("webp") as Extract<SaveOutcome, { kind: "saved" }>;
  const note = savedText(out, "Cats", { kind: "append", packId: 2 });
  expect(note).toBe("Saved as 004.webp, sticker #4 of “Cats” (2.0 KB, WEBP quality 80). Give it an Emoji String in the Pack Manager.");
  const png = saved("png") as Extract<SaveOutcome, { kind: "saved" }>;
  expect(savedText(png, "Cats", { kind: "append", packId: 2 })).not.toContain("quality");
  const withEmoji = { ...png, sticker: { ...png.sticker, emojiString: "🐱" } };
  expect(savedText(withEmoji, "Cats", { kind: "replace", stickerId: 9 })).toBe("Replaced #4 in “Cats”.");
});

const origin = { stickerId: 9, packId: 2, position: 4, packTitle: "Cats" };
const viewWith = (stickers: { id: number; position: number; format: "png" | "webp" }[], title = "Cats") =>
  ({ pack: { title }, stickers }) as unknown as import("../src/pack-manager/api").PackView;

test("the origin sticker is found where it is now, or reported gone", () => {
  // Reordered within its pack, pack renamed: still the same sticker.
  expect(resolveOrigin(origin, viewWith([{ id: 9, position: 2, format: "webp" }], "Kittens"))).toEqual({
    position: 2,
    packTitle: "Kittens",
    format: "webp",
  });
  // Deleted or moved to another pack, or the pack is gone: never another slot.
  const gone = resolveOrigin(origin, viewWith([{ id: 8, position: 4, format: "png" }]));
  expect("gone" in gone && gone.gone).toContain("Sticker #4 of “Cats” no longer exists");
  expect("gone" in resolveOrigin(origin, null)).toBe(true);
  expect(replaceLabel({ position: 2, packTitle: "Kittens", format: "png" })).toBe("Replace #2 in “Kittens”");
});

test("after a save the session edits the saved sticker, and a replace says so", () => {
  const out = saved("png") as Extract<SaveOutcome, { kind: "saved" }>;
  expect(originAfterSave(out, "Cats")).toEqual({ stickerId: 9, packId: 2, position: 4, packTitle: "Cats" });
  expect(savedText(out, "Cats", { kind: "replace", stickerId: 9 })).toBe("Replaced #4 in “Cats”.");
});

test("after a Library change the origin sticker is reported, not looked up", () => {
  const gone = resolveOrigin({ ...origin, otherLibrary: true }, viewWith([{ id: 9, position: 4, format: "png" }]));
  expect("gone" in gone && gone.gone).toContain("belongs to the Library used before");
});

test("only a clean session with a gone origin warns on close (owner decision 2026-11-23)", () => {
  // The same existence notion as the save dialog's Replace option: gone
  // (deleted or moved), another Library, or present.
  const deleted = resolveOrigin(origin, viewWith([]));
  expect(originGoneCloseWarning(origin, deleted)).toBe(true);
  const otherLibrary = resolveOrigin({ ...origin, otherLibrary: true }, viewWith([{ id: 9, position: 4, format: "png" }]));
  expect(originGoneCloseWarning(origin, otherLibrary)).toBe(true);
  const present = resolveOrigin(origin, viewWith([{ id: 9, position: 2, format: "png" }]));
  expect(originGoneCloseWarning(origin, present)).toBe(false);
  // No origin (a plain file, never saved into a slot): never warns.
  expect(originGoneCloseWarning(null, deleted)).toBe(false);
  // A dirty session never reaches the check: its own warning decides.
  expect(originGoneCloseWarning(null, present)).toBe(false);
});

test("the saved note's link names the sticker; a gone sticker is reported", () => {
  const out = saved("png") as Extract<SaveOutcome, { kind: "saved" }>;
  expect(showStickerLink(out.sticker, "Cats")).toEqual({
    text: "Show in Pack Manager",
    label: "Show in Pack Manager: sticker #4 of “Cats”",
  });
  expect(stickerGoneText(4, "Cats")).toBe("Sticker #4 of “Cats” no longer exists (it was deleted or moved since it was saved).");
  expect(stickerGoneText(4, "Cats", true)).toContain("saved into the Library used before");
});

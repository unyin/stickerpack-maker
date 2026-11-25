// The Upload list's pure rules (SPEC §5, SPM-21): entries, availability, notes, width.
import { expect, test } from "bun:test";
import type { PackView, StickerView } from "../src/pack-manager/api";
import { MISSING_REASON, packSizeText } from "../src/pack-manager/model/messages";
import {
  draftNote,
  emojiRowWidth,
  EMOJI_PER_ROW,
  THUMBNAIL_MISSING_REASON,
  uploadDialogWidth,
  uploadEntries,
  uploadListBlocker,
} from "../src/pack-manager/model/upload-list";

function sticker(position: number, missing = false): StickerView {
  return {
    id: position * 10,
    packId: 1,
    position,
    fileName: `${String(position).padStart(3, "0")}.png`,
    format: "png",
    emojiString: "😀",
    missing,
    emojiWarning: null,
    file: missing ? null : { bytes: 1000, width: 512, height: 512 },
  };
}

function view(stickers: StickerView[], thumbnail: string | null = null, thumbnailMissing = false): PackView {
  return {
    pack: { id: 1, title: "T", shortName: "t", status: "draft", thumbnail, folderRenameFrom: null },
    stickers,
    thumbnailMissing,
    thumbnailFile: thumbnail && !thumbnailMissing ? { bytes: 500, width: 100, height: 100 } : null,
    packSizeWarning: null,
  };
}

test("the Upload list needs at least one sticker; a thumbnail alone does not count", () => {
  expect(uploadListBlocker(0)).toBe("The pack has no stickers yet");
  expect(uploadListBlocker(1)).toBeNull();
  expect(uploadListBlocker(125)).toBeNull();
});

test("entries are the stickers in pack order, then the thumbnail when the pack has one", () => {
  const v = view([sticker(1), sticker(2)], "thumbnail.png");
  const entries = uploadEntries(v);
  expect(entries.map((e) => e.kind)).toEqual(["sticker", "sticker", "thumbnail"]);
  expect(uploadEntries(view([sticker(1)])).map((e) => e.kind)).toEqual(["sticker"]);
});

test("Missing entries carry the app's Missing reason; the thumbnail has its own", () => {
  const [ok, gone] = uploadEntries(view([sticker(1), sticker(2, true)]));
  expect(ok.missingReason).toBeNull();
  expect(gone.missingReason).toBe(MISSING_REASON);
  const thumb = uploadEntries(view([sticker(1)], "thumbnail.png", true))[1];
  expect(thumb.missingReason).toBe(THUMBNAIL_MISSING_REASON);
  expect(THUMBNAIL_MISSING_REASON).toBe("The thumbnail file is Missing; replace it first.");
});

test("Open in explorer buttons have descriptive accessible names", () => {
  const [first, , thumb] = uploadEntries(view([sticker(1), sticker(2)], "thumbnail.webp"));
  expect(first.explorerLabel).toBe("Open #1 in explorer");
  expect(thumb.explorerLabel).toBe("Open thumbnail in explorer");
});

test("each entry names the one file it stands for", () => {
  const [first, thumb] = uploadEntries(view([sticker(1)], "thumbnail.webp"));
  expect(first.target).toEqual({ kind: "sticker", id: 10, format: "png" });
  expect(first.imageAlt).toBe("Sticker 1");
  expect(thumb.target).toEqual({ kind: "thumbnail", packId: 1, format: "webp" });
  expect(thumb.imageAlt).toBe("Thumbnail");
});

test("only a Draft pack shows the reminder", () => {
  expect(draftNote("draft")).toBe("This pack is a Draft: press Go Live once @Stickers' /publish succeeds.");
  expect(draftNote("live")).toBeNull();
});

test("past 120 stickers the over-limit warning shows, at or under it nothing does", () => {
  expect(packSizeText(120)).toBeNull();
  expect(packSizeText(125)).toContain("125 stickers");
});

test("the preferred width fits ten emoji per row with half a glyph to spare", () => {
  expect(EMOJI_PER_ROW).toBe(10);
  expect(emojiRowWidth(24)).toBe(252); // 10.5 × 24: ten fit, eleven do not
  expect(emojiRowWidth(27.4)).toBe(288); // rounds up
  expect(uploadDialogWidth(24, 30, 300)).toBe(252 + 30 + 300);
});

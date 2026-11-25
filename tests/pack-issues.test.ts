// The one issue rule for a pack, the Pack list's status badge and row choices
// (SPEC §5, SPM-25; owner-approved wording, 2026-11-25).
import { expect, test } from "bun:test";
import type { PackView, StickerView } from "../src/pack-manager/api";
import {
  packFactsOfView,
  packIssues,
  readyToGoLive,
  READY_DETAIL,
  READY_LABEL,
  statusBadgeOf,
  type PackFacts,
} from "../src/pack-manager/model/pack-issues";
import { rowThumbnail } from "../src/pack-manager/model/pack-row";

const good = (n: number): string[] => Array.from({ length: n }, () => "😀");

function facts(over: Partial<PackFacts> = {}): PackFacts {
  const emojiStrings = over.emojiStrings ?? good(over.stickerCount ?? 3);
  return { status: "draft", stickerCount: emojiStrings.length, missingCount: 0, thumbnailMissing: false, emojiStrings, ...over };
}

const labels = (f: PackFacts) => packIssues(f).map((i) => i.label);

test("a clean Draft has no issues and is ready", () => {
  expect(packIssues(facts())).toEqual([]);
  expect(readyToGoLive(facts())).toBe(true);
});

test("Missing stickers: badge N Missing, singular and plural tooltip", () => {
  const [one] = packIssues(facts({ missingCount: 1 }));
  expect(one).toEqual({ kind: "missing", label: "1 Missing", detail: "1 sticker is Missing" });
  const [many] = packIssues(facts({ missingCount: 4 }));
  expect(many.label).toBe("4 Missing");
  expect(many.detail).toBe("4 stickers are Missing");
});

test("a Missing thumbnail file", () => {
  expect(packIssues(facts({ thumbnailMissing: true }))).toEqual([
    { kind: "thumbnailMissing", label: "Thumbnail Missing", detail: "The thumbnail file is Missing" },
  ]);
});

test("over the limit: 120 passes, 121 is N / 120", () => {
  expect(packIssues(facts({ emojiStrings: good(120) }))).toEqual([]);
  expect(packIssues(facts({ emojiStrings: good(125) }))).toEqual([
    { kind: "overLimit", label: "125 / 120", detail: "125 stickers: Telegram allows at most 120" },
  ]);
});

test("emoji issues count Emoji Strings outside 1-20, by graphemes, with an en dash", () => {
  const one = packIssues(facts({ emojiStrings: ["😀", "", "😀"] }));
  expect(one).toEqual([
    { kind: "emoji", label: "1 emoji issue", detail: "1 sticker's Emoji String is outside 1–20" },
  ]);
  const three = packIssues(facts({ emojiStrings: ["", "  ", "😀".repeat(21), "😀".repeat(20), "👨‍👩‍👧".repeat(20)] }));
  expect(three[0].label).toBe("3 emoji issues");
  expect(three[0].detail).toBe("3 stickers' Emoji Strings are outside 1–20");
});

test("an empty pack: Empty", () => {
  expect(packIssues(facts({ emojiStrings: [] }))).toEqual([{ kind: "empty", label: "Empty", detail: "No stickers yet" }]);
});

test("issues come most severe first: Missing, thumbnail, limit, emoji, Empty", () => {
  const all = facts({ missingCount: 2, thumbnailMissing: true, emojiStrings: ["", ...good(124)] });
  expect(packIssues(all).map((i) => i.kind)).toEqual(["missing", "thumbnailMissing", "overLimit", "emoji"]);
  // Empty can only stand beside the thumbnail issue (no stickers means no others).
  expect(packIssues(facts({ emojiStrings: [], thumbnailMissing: true })).map((i) => i.kind)).toEqual([
    "thumbnailMissing",
    "empty",
  ]);
});

test("a Missing sticker with an empty Emoji String counts under both", () => {
  expect(labels(facts({ missingCount: 1, emojiStrings: ["", "😀"] }))).toEqual(["1 Missing", "1 emoji issue"]);
});

test("the badge is the most severe label plus +N, tooltip lines joined by newlines", () => {
  const badge = statusBadgeOf(facts({ missingCount: 2, thumbnailMissing: true, emojiStrings: ["", "😀"] }));
  expect(badge).toEqual({
    tone: "issue",
    label: "2 Missing +2",
    title: "2 stickers are Missing\nThe thumbnail file is Missing\n1 sticker's Emoji String is outside 1–20",
  });
  expect(statusBadgeOf(facts({ missingCount: 1 }))?.label).toBe("1 Missing");
});

test("a Draft with no issues is Ready to upload; a Live pack with none shows no badge", () => {
  expect(statusBadgeOf(facts())).toEqual({ tone: "ready", label: READY_LABEL, title: READY_DETAIL });
  expect(READY_LABEL).toBe("Ready to upload");
  expect(READY_DETAIL).toBe("Every check passes: ready for @Stickers");
  expect(statusBadgeOf(facts({ status: "live" }))).toBeNull();
});

test("issues show on a Live pack, which is never ready", () => {
  const live = facts({ status: "live", missingCount: 1 });
  expect(statusBadgeOf(live)?.tone).toBe("issue");
  expect(readyToGoLive(live)).toBe(false);
  expect(readyToGoLive(facts({ status: "live" }))).toBe(false);
});

test("readyToGoLive is the same rule as the badge for every case", () => {
  const cases = [
    facts(),
    facts({ missingCount: 1 }),
    facts({ thumbnailMissing: true }),
    facts({ emojiStrings: good(121) }),
    facts({ emojiStrings: [""] }),
    facts({ emojiStrings: [] }),
    facts({ status: "live" }),
  ];
  for (const f of cases) expect(readyToGoLive(f)).toBe(statusBadgeOf(f)?.tone === "ready");
});

function view(over: { thumbnail?: string | null; thumbnailMissing?: boolean; thumbnailFile?: boolean } = {}): PackView {
  const sticker = (id: number, missing: boolean, emojiString: string): StickerView => ({
    id,
    packId: 1,
    position: id,
    fileName: `00${id}.png`,
    format: "png",
    emojiString,
    missing,
    emojiWarning: null,
    file: missing ? null : { bytes: 1, width: 512, height: 512 },
  });
  const thumbnail = over.thumbnail ?? null;
  return {
    pack: { id: 1, title: "T", shortName: "t", status: "draft", thumbnail, folderRenameFrom: null },
    stickers: [sticker(1, true, "😀"), sticker(2, false, ""), sticker(3, false, "😀")],
    thumbnailMissing: over.thumbnailMissing ?? false,
    thumbnailFile: thumbnail && over.thumbnailFile !== false ? { bytes: 1, width: 100, height: 100 } : null,
    packSizeWarning: null,
  };
}

test("the Pack view's adapter derives the facts", () => {
  expect(packFactsOfView(view())).toEqual({
    status: "draft",
    stickerCount: 3,
    missingCount: 1,
    thumbnailMissing: false,
    emojiStrings: ["😀", "", "😀"],
  });
  expect(packFactsOfView(view({ thumbnail: "thumbnail.png", thumbnailMissing: true })).thumbnailMissing).toBe(true);
  // A thumbnail row whose file facts are absent is Missing too, as the Upload list reads it.
  expect(packFactsOfView(view({ thumbnail: "thumbnail.png", thumbnailFile: false })).thumbnailMissing).toBe(true);
  expect(packFactsOfView(view({ thumbnail: "thumbnail.png" })).thumbnailMissing).toBe(false);
});

test("thumbnail cell: own, first sticker, Missing art, or nothing", () => {
  const first = { id: 7, format: "png" as const, missing: false };
  expect(rowThumbnail({ thumbnail: "thumbnail.png", thumbnailMissing: false, firstSticker: first, checkError: null })).toEqual({
    kind: "own",
    title: "Thumbnail",
  });
  expect(rowThumbnail({ thumbnail: null, thumbnailMissing: false, firstSticker: first, checkError: null })).toEqual({
    kind: "first",
    title: "No thumbnail: Telegram shows the first sticker",
    stickerId: 7,
  });
  expect(rowThumbnail({ thumbnail: null, thumbnailMissing: false, firstSticker: { id: 7, format: "png", missing: true }, checkError: null })).toEqual({
    kind: "missing",
    title: "No thumbnail: Telegram shows the first sticker, which is Missing",
  });
  expect(rowThumbnail({ thumbnail: "thumbnail.png", thumbnailMissing: true, firstSticker: first, checkError: null })).toEqual({
    kind: "missing",
    title: "The thumbnail file is Missing",
  });
  expect(rowThumbnail({ thumbnail: null, thumbnailMissing: false, firstSticker: null, checkError: null })).toEqual({
    kind: "none",
    title: "No thumbnail and no stickers yet",
  });
});

test("a failed check shows the neutral placeholder, whatever the files say", () => {
  const first = { id: 7, format: "png" as const, missing: false };
  const expected = { kind: "none", title: "The pack could not be checked" };
  expect(rowThumbnail({ thumbnail: "thumbnail.png", thumbnailMissing: false, firstSticker: first, checkError: "boom" })).toEqual(expected);
  expect(rowThumbnail({ thumbnail: null, thumbnailMissing: false, firstSticker: first, checkError: "boom" })).toEqual(expected);
});

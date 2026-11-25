// The session's Emoji String (SPEC §3, §6 Layout; SPM-15): a fresh session
// stages it for the save, an origin session reads and writes the sticker's
// own string through, and a gone or old-Library origin disables the box.
import { expect, test } from "bun:test";
import { EMOJI_GONE, EMOJI_OTHER_LIBRARY, SessionEmoji, stripEmojiSpaces, type EmojiStore } from "../src/editor/model/emoji";

/** A fake Library: one sticker's string, and every call recorded. */
function store(initial: string): EmojiStore & { calls: string[]; value: string } {
  const fake = {
    calls: [] as string[],
    value: initial,
    async read(packId: number, stickerId: number) {
      fake.calls.push(`read ${packId}/${stickerId}`);
      return fake.value;
    },
    async write(stickerId: number, emojiString: string) {
      fake.calls.push(`write ${stickerId} ${emojiString}`);
      fake.value = stripEmojiSpaces(emojiString);
      return fake.value;
    },
  };
  return fake;
}

const ORIGIN = { kind: "origin", stickerId: 7, packId: 3 } as const;

test("a fresh session stages the typed string and writes it only at save, space-stripped", async () => {
  const fake = store("");
  const emoji = new SessionEmoji({ kind: "staged" }, fake);
  expect(emoji.value).toBe("");
  expect(emoji.blocked).toBeNull();
  await emoji.load(); // nothing to read
  expect(fake.calls).toEqual([]);
  expect(await emoji.commit("😀 🎉")).toBe("😀 🎉"); // staged as typed; the count ignores spaces
  expect(emoji.value).toBe("😀 🎉");
  expect(fake.calls).toEqual([]);
  // The save writes the stripped string for a new sticker, and nothing for a replace.
  expect(emoji.forSave("append")).toBe("😀🎉");
  expect(emoji.forSave("replace")).toBe("");
  expect(emoji.forSave("thumbnail")).toBe("");
});

test("validation is warn-only: empty and over-twenty strings still commit", async () => {
  const emoji = new SessionEmoji({ kind: "staged" }, store(""));
  await emoji.commit("");
  expect(emoji.warning).toContain("No emoji");
  expect(emoji.value).toBe("");
  await emoji.commit("😀".repeat(21));
  expect(emoji.warning).toContain("at most 20");
  expect(emoji.value.length).toBeGreaterThan(0);
  await emoji.commit("😀");
  expect(emoji.warning).toBeNull();
});

test("an origin session reads the sticker's string once and writes every commit through", async () => {
  const fake = store("🐶");
  const emoji = new SessionEmoji(ORIGIN, fake);
  expect(emoji.value).toBe(""); // not read yet
  await emoji.load();
  expect(emoji.value).toBe("🐶");
  expect(fake.calls).toEqual(["read 3/7"]);
  await emoji.load(); // one read per session
  expect(fake.calls).toEqual(["read 3/7"]);
  // A commit is pack metadata: written through immediately, not an undo step.
  expect(await emoji.commit("🐱 🐭")).toBe("🐱🐭");
  expect(fake.calls).toEqual(["read 3/7", "write 7 🐱 🐭"]);
  expect(emoji.value).toBe("🐱🐭");
  // A save as a new sticker carries the string; a replace keeps the sticker's own (here returned as "").
  expect(emoji.forSave("append")).toBe("🐱🐭");
  expect(emoji.forSave("replace")).toBe("");
});

test("an old Library's sticker is never looked up; the box is blocked with its reason", async () => {
  const fake = store("🐶");
  const emoji = new SessionEmoji({ ...ORIGIN, otherLibrary: true }, fake);
  await emoji.load();
  expect(fake.calls).toEqual([]);
  expect(emoji.blocked).toEqual(EMOJI_OTHER_LIBRARY);
  expect(emoji.value).toBe("");
  // A commit while blocked does nothing, and a save writes no emoji.
  expect(await emoji.commit("🐱")).toBe("");
  expect(fake.calls).toEqual([]);
  expect(emoji.forSave("append")).toBe("");
});

test("a gone origin disables the box with its reason and refuses a write", async () => {
  const fake = store("🐶");
  fake.read = async () => {
    throw new Error("sticker 7 is not in its pack");
  };
  const emoji = new SessionEmoji(ORIGIN, fake);
  await emoji.load();
  expect(emoji.blocked).toEqual(EMOJI_GONE);
  expect(emoji.value).toBe("");
  expect(fake.calls).toEqual([]);
  expect(await emoji.commit("🐱")).toBe("");
  expect(fake.calls).toEqual([]);
});

test("after a save the session edits the saved sticker, so the box writes through from then on", async () => {
  const fake = store("");
  const emoji = new SessionEmoji({ kind: "staged" }, fake);
  await emoji.commit("😀");
  emoji.afterSave({ id: 12, packId: 4, emojiString: "😀" });
  expect(emoji.blocked).toBeNull();
  expect(emoji.value).toBe("😀");
  // The next replace keeps the sticker's own string; a new sticker would carry it.
  expect(emoji.forSave("replace")).toBe("");
  expect(emoji.forSave("append")).toBe("😀");
  expect(await emoji.commit("😀🎉")).toBe("😀🎉");
  expect(fake.calls).toEqual(["write 12 😀🎉"]);
});

test("stripEmojiSpaces removes every kind of whitespace", () => {
  expect(stripEmojiSpaces(" 😀\t🎉\n")).toBe("😀🎉");
  expect(stripEmojiSpaces("")).toBe("");
});

test("a Library change forbids looking the origin up again; a staged session is unaffected", async () => {
  const fake = store("🐶");
  const emoji = new SessionEmoji(ORIGIN, fake);
  emoji.forgetOrigin();
  await emoji.load();
  expect(emoji.blocked).toEqual(EMOJI_OTHER_LIBRARY);
  expect(fake.calls).toEqual([]);
  expect(await emoji.commit("🐱")).toBe("");
  expect(fake.calls).toEqual([]);
  // A fresh session has no old sticker id: its staged box keeps working.
  const staged = new SessionEmoji({ kind: "staged" }, fake);
  staged.forgetOrigin();
  expect(staged.blocked).toBeNull();
  expect(await staged.commit("😀")).toBe("😀");
});

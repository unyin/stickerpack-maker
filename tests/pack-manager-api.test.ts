// Pack Manager command wiring without a running Tauri app: names and
// argument keys must match src-tauri/src/pack_commands.rs.
import { expect, mock, test } from "bun:test";

const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return null;
  },
  Channel: class {},
}));
const dialogOptions: Array<Record<string, unknown>> = [];
mock.module("@tauri-apps/plugin-dialog", () => ({
  open: async (opts: Record<string, unknown>) => {
    dialogOptions.push(opts);
    return opts.multiple ? ["C:\\a.png", "C:\\b.webp"] : "C:\\a.png";
  },
  ask: async () => true,
}));

const api = await import("../src/pack-manager/api");

test("commands use the Rust names and camelCase argument keys", async () => {
  calls.length = 0;
  await api.listPacks();
  await api.suggestShortName("Cats");
  await api.createPack("Cats", null);
  await api.deletePack(1);
  await api.openPack(1);
  await api.setPackTitle(1, "T");
  await api.setPackShortName(1, "t");
  await api.setPackStatus(1, "live");
  await api.reorderSticker(5, 2);
  await api.deleteStickers(1, [5, 6]);
  await api.setEmojiString(5, "😀");
  await api.importStickers(1, ["C:\\a.png"]);
  await api.checkStickerFile("C:\\a.png");
  await api.replaceSticker(5, "C:\\a.png");
  await api.sendToPack([5], 2, true);
  await api.stickerFilePath(5);
  await api.revealSticker(5);
  await api.revealThumbnail(1);
  await api.stickerImage(5);
  await api.thumbnailImage(1);
  expect(calls).toEqual([
    { cmd: "list_packs", args: undefined },
    { cmd: "suggest_short_name", args: { title: "Cats" } },
    { cmd: "create_pack", args: { title: "Cats", shortName: null } },
    { cmd: "delete_pack", args: { packId: 1 } },
    { cmd: "open_pack", args: { packId: 1 } },
    { cmd: "set_pack_title", args: { packId: 1, title: "T" } },
    { cmd: "set_pack_short_name", args: { packId: 1, shortName: "t" } },
    { cmd: "set_pack_status", args: { packId: 1, status: "live" } },
    { cmd: "reorder_sticker", args: { stickerId: 5, newPosition: 2 } },
    { cmd: "delete_stickers", args: { packId: 1, stickerIds: [5, 6] } },
    { cmd: "set_emoji_string", args: { stickerId: 5, emojiString: "😀" } },
    { cmd: "import_stickers", args: { packId: 1, paths: ["C:\\a.png"] } },
    { cmd: "check_sticker_file", args: { path: "C:\\a.png" } },
    { cmd: "replace_sticker", args: { stickerId: 5, path: "C:\\a.png" } },
    { cmd: "send_to_pack", args: { stickerIds: [5], targetPackId: 2, deleteOriginals: true } },
    { cmd: "sticker_file_path", args: { stickerId: 5 } },
    { cmd: "reveal_sticker", args: { stickerId: 5 } },
    { cmd: "reveal_thumbnail", args: { packId: 1 } },
    { cmd: "sticker_image", args: { stickerId: 5 } },
    { cmd: "thumbnail_image", args: { packId: 1 } },
  ]);
});

test("the sticker picker filters PNG/WEBP and always returns a list", async () => {
  expect(await api.pickStickerFiles(true, "Add")).toEqual(["C:\\a.png", "C:\\b.webp"]);
  expect(await api.pickStickerFiles(false, "Replace")).toEqual(["C:\\a.png"]);
  expect(dialogOptions[0].filters).toEqual([{ name: "Stickers (PNG, WEBP)", extensions: ["png", "webp"] }]);
});

test("send failures are recognised by shape", () => {
  expect(api.isSendFailure({ message: "m", fileErrors: [] })).toBe(true);
  expect(api.isSendFailure("plain error")).toBe(false);
  expect(api.isSendFailure({ message: "m" })).toBe(false);
});

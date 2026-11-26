// Verifies the TS <-> Rust command wiring without a running Tauri app:
// command names and argument shapes must match src-tauri/src/commands.rs
// (registered in src-tauri/src/lib.rs::invoke_handler).
import { expect, mock, test } from "bun:test";
import { baseName } from "../src/shared/path";

const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
const fakeState = {
  libraryPath: null,
  libraryStatus: "unconfigured",
  libraryError: null,
  emojiStyle: "android",
  customEmojiFontPath: null,
};

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "default_library_path") {
      return "C:\\Users\\test\\Documents\\Stickerpack Library";
    }
    return fakeState;
  },
  Channel: class {},
}));

const dialogCalls: Array<Record<string, unknown>> = [];
mock.module("@tauri-apps/plugin-dialog", () => ({
  open: async (opts: Record<string, unknown>) => {
    dialogCalls.push(opts);
    return "F:\\Libraries\\cats\\library.db";
  },
  ask: async () => true,
}));

const api = await import("../src/api");

test("command names match the Rust invoke_handler", async () => {
  await api.getAppState();
  await api.getDefaultLibraryPath();
  await api.createLibrary("C:\\lib-a");
  await api.repointLibrary("C:\\lib-b");
  expect(calls.map((c) => c.cmd)).toEqual([
    "get_app_state",
    "default_library_path",
    "create_library",
    "repoint_library",
  ]);
  expect(calls[2].args).toEqual({ path: "C:\\lib-a" });
  expect(calls[3].args).toEqual({ path: "C:\\lib-b" });
});

test("app state fields are camelCase as serialized by serde", async () => {
  const state = await api.getAppState();
  expect(state).toEqual(fakeState);
});

test("default library path ends with Documents\\Stickerpack Library", async () => {
  const path = await api.getDefaultLibraryPath();
  expect(path.endsWith("Documents\\Stickerpack Library")).toBe(true);
});

test("pickLibraryDb opens a single-file picker filtered to .db (SPM-13)", async () => {
  const file = await api.pickLibraryDb("F:\\Libraries");
  expect(file).toBe("F:\\Libraries\\cats\\library.db");
  const opts = dialogCalls[0];
  expect(opts.directory).toBe(false);
  expect(opts.multiple).toBe(false);
  expect(opts.defaultPath).toBe("F:\\Libraries");
  expect(opts.filters).toEqual([
    { name: "Stickerpack Library (library.db)", extensions: ["db"] },
  ]);
});

test("parentFolder derives the Library folder from the db path", () => {
  expect(api.parentFolder("F:\\Libraries\\cats\\library.db")).toBe(
    "F:\\Libraries\\cats",
  );
  expect(api.parentFolder("F:\\library.db")).toBe("F:\\");
  expect(api.parentFolder("C:/lib/library.db")).toBe("C:/lib");
  // No separator: dirname semantics — the file lives in the current directory.
  expect(api.parentFolder("library.db")).toBe(".");
});

test("baseName returns the last segment for Windows and POSIX paths", () => {
  expect(baseName("F:\\Libraries\\cats\\library.db")).toBe("library.db");
  expect(baseName("/home/user/lib/library.db")).toBe("library.db");
  expect(baseName("library.db")).toBe("library.db");
  expect(baseName("F:\\library.db")).toBe("library.db");
});

test("marker name matches the Rust DB_FILE_NAME constant", () => {
  expect(api.LIBRARY_DB_FILE_NAME).toBe("library.db");
});

test("isLibraryDbFile is an exact, case-sensitive name match (SPM-13)", () => {
  expect(api.isLibraryDbFile("F:\\Libraries\\cats\\library.db")).toBe(true);
  expect(api.isLibraryDbFile("/home/user/lib/library.db")).toBe(true);
  // Rust looks for exactly "library.db" on every platform; LIBRARY.DB must
  // not pass the frontend guard only to fail in the core on case-sensitive FS.
  expect(api.isLibraryDbFile("F:\\lib\\LIBRARY.DB")).toBe(false);
  expect(api.isLibraryDbFile("F:\\lib\\other.db")).toBe(false);
  expect(api.isLibraryDbFile("F:\\lib\\library.db.bak")).toBe(false);
});

test("resolveLibraryDbSelection covers cancel, invalid name, and re-point wiring", async () => {
  expect(api.resolveLibraryDbSelection(null)).toEqual({ kind: "cancelled" });
  expect(api.resolveLibraryDbSelection("F:\\lib\\other.db")).toEqual({
    kind: "invalid-name",
  });
  expect(api.resolveLibraryDbSelection("F:\\lib\\LIBRARY.DB")).toEqual({
    kind: "invalid-name",
  });
  // The settings flow re-points at the PARENT FOLDER of the picked file.
  const selection = api.resolveLibraryDbSelection(
    "F:\\Libraries\\cats\\library.db",
  );
  expect(selection).toEqual({ kind: "ok", folder: "F:\\Libraries\\cats" });
  if (selection.kind === "ok") {
    await api.repointLibrary(selection.folder);
    const last = calls[calls.length - 1];
    expect(last.cmd).toBe("repoint_library");
    expect(last.args).toEqual({ path: "F:\\Libraries\\cats" });
  }
  expect(api.resolveLibraryDbSelection("/library.db")).toEqual({
    kind: "ok",
    folder: "/",
  });
  expect(api.resolveLibraryDbSelection("library.db")).toEqual({
    kind: "ok",
    folder: ".",
  });
});

test("setEmojiStyle posts the style and the camelCase custom path (SPM-17)", async () => {
  await api.setEmojiStyle("custom", "C:\\Fonts\\my-emoji.ttf");
  expect(calls[calls.length - 1]).toEqual({
    cmd: "set_emoji_style",
    args: { style: "custom", customPath: "C:\\Fonts\\my-emoji.ttf" },
  });
  await api.setEmojiStyle("twemoji");
  expect(calls[calls.length - 1]).toEqual({
    cmd: "set_emoji_style",
    args: { style: "twemoji", customPath: undefined },
  });
});

test("readCustomEmojiFont posts the path under the same command name as Rust (SPM-17)", async () => {
  await api.readCustomEmojiFont("C:\\Fonts\\my-emoji.ttf");
  expect(calls[calls.length - 1]).toEqual({
    cmd: "read_custom_emoji_font",
    args: { path: "C:\\Fonts\\my-emoji.ttf" },
  });
});

test("pickEmojiFont is a single-file picker filtered to font containers (SPM-17)", async () => {
  const file = await api.pickEmojiFont();
  expect(file).toBe("F:\\Libraries\\cats\\library.db"); // the dialog mock's return
  const opts = dialogCalls[dialogCalls.length - 1];
  expect(opts.directory).toBe(false);
  expect(opts.multiple).toBe(false);
  expect(opts.filters).toEqual([
    { name: "Font file", extensions: ["ttf", "otf", "woff2"] },
  ]);
});
// Editor command wiring and binary frame parsing, without a running Tauri
// app: names and argument keys must match src-tauri/src/commands.rs.
import { expect, mock, test } from "bun:test";

const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

/** A frame as Rgba::to_frame writes it. */
function frame(width: number, height: number, fill: number): ArrayBuffer {
  const buf = new ArrayBuffer(8 + width * height * 4);
  const view = new DataView(buf);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  new Uint8Array(buf, 8).fill(fill);
  return buf;
}

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "editor_probe_image") {
      return { width: 2400, height: 1200, exceedsCap: true };
    }
    return frame(2, 1, 7);
  },
  Channel: class {},
}));

const dialogCalls: Array<Record<string, unknown>> = [];
mock.module("@tauri-apps/plugin-dialog", () => ({
  open: async (opts: Record<string, unknown>) => {
    dialogCalls.push(opts);
    return "C:\\pics\\cat.jfif";
  },
  ask: async () => true,
}));

const api = await import("../src/editor/api");

test("editor commands and argument keys match the Rust side", async () => {
  const info = await api.probeImage("C:\\pics\\big.png");
  expect(info).toEqual({ width: 2400, height: 1200, exceedsCap: true });
  const img = await api.importImage("C:\\pics\\big.png", true);
  expect(calls.map((c) => c.cmd)).toEqual([
    "editor_probe_image",
    "editor_import_image",
  ]);
  expect(calls[0].args).toEqual({ path: "C:\\pics\\big.png" });
  // Tauri maps camelCase keys to the Rust snake_case parameter scale_to_fit.
  expect(calls[1].args).toEqual({ path: "C:\\pics\\big.png", scaleToFit: true });
  expect(img.width).toBe(2);
  expect(img.height).toBe(1);
  expect(Array.from(img.pixels)).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
});

test("decodeFrame reads the little-endian header and shares the pixels", () => {
  const img = api.decodeFrame(frame(3, 2, 255));
  expect(img.width).toBe(3);
  expect(img.height).toBe(2);
  expect(img.pixels.length).toBe(24);
  expect(img.pixels).toBeInstanceOf(Uint8ClampedArray);
});

test("decodeFrame rejects truncated or mis-sized frames", () => {
  expect(() => api.decodeFrame(new ArrayBuffer(4))).toThrow("truncated");
  const short = frame(3, 2, 0).slice(0, 20);
  expect(() => api.decodeFrame(short)).toThrow("expected 32");
});

test("the import picker offers exactly the five Editor formats", async () => {
  expect(await api.pickImageFile()).toBe("C:\\pics\\cat.jfif");
  expect(dialogCalls[0].filters).toEqual([
    { name: "Images", extensions: ["jpg", "jpeg", "jfif", "png", "webp"] },
  ]);
  expect(api.IMPORT_MAX_SIDE).toBe(2000);
});

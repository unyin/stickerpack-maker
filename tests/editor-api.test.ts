// Editor command wiring and binary frame parsing, without a running Tauri
// app: names and argument keys must match src-tauri/src/commands.rs.
import { expect, mock, test } from "bun:test";
import limits from "../src/shared/limits.json";

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

const options: Array<unknown> = [];

/** A Placed frame: i32 LE origin, then an image frame. */
function placedFrame(x: number, y: number, inner: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(8 + inner.byteLength);
  const view = new DataView(out.buffer);
  view.setInt32(0, x, true);
  view.setInt32(4, y, true);
  out.set(new Uint8Array(inner), 8);
  return out.buffer;
}

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>, opts?: unknown) => {
    calls.push({ cmd, args });
    options.push(opts);
    if (cmd === "editor_probe_image") {
      return { width: 2400, height: 1200, exceedsCap: true };
    }
    if (cmd === "editor_merge_layers") return placedFrame(-2, 3, frame(1, 1, 5));
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
  // The one definition of the import cap, which Rust's build.rs reads too.
  expect(api.IMPORT_MAX_SIDE).toBe(limits.importMaxSide);
});

test("merge sends one raw body plus a size/transform header", async () => {
  const t = { x: 1, y: 2, scaleX: 1, scaleY: 1, rotation: 0 };
  const a = { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 4]) };
  const b = { width: 2, height: 1, pixels: new Uint8ClampedArray([5, 6, 7, 8, 9, 10, 11, 12]) };
  const placed = await api.mergeImages([
    { image: a, transform: t },
    { image: b, transform: { ...t, rotation: 90 } },
  ]);
  const call = calls[calls.length - 1];
  expect(call.cmd).toBe("editor_merge_layers");
  expect(Array.from(call.args as unknown as Uint8Array)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  ]);
  const headers = (options[options.length - 1] as { headers: Record<string, string> }).headers;
  expect(JSON.parse(headers["x-merge-layers"])).toEqual([
    { width: 1, height: 1, transform: t },
    { width: 2, height: 1, transform: { ...t, rotation: 90 } },
  ]);
  expect(placed.x).toBe(-2);
  expect(placed.y).toBe(3);
  expect(Array.from(placed.image.pixels)).toEqual([5, 5, 5, 5]);
});

test("decodePlacedFrame reads a signed origin", () => {
  const p = api.decodePlacedFrame(placedFrame(-7, -1, frame(1, 1, 0)));
  expect([p.x, p.y, p.image.width]).toEqual([-7, -1, 1]);
  expect(() => api.decodePlacedFrame(new ArrayBuffer(3))).toThrow("truncated");
});

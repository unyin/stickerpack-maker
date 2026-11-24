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

/** A frame as EffectResult::to_frame writes it: five f32 transform values, then an image frame. */
function effectFrame(transform: number[], inner: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(20 + inner.byteLength);
  const view = new DataView(out.buffer);
  transform.forEach((v, i) => view.setFloat32(i * 4, v, true));
  out.set(new Uint8Array(inner), 20);
  return out.buffer;
}

/** A frame as TextRender::to_frame writes it: five f32 metrics, then a 3x2 image. */
function textFrame(): ArrayBuffer {
  const image = new Uint8Array(frame(3, 2, 4));
  const out = new Uint8Array(20 + image.length);
  const view = new DataView(out.buffer);
  [1.5, 0, 40, 10, 55].forEach((v, i) => view.setFloat32(i * 4, v, true));
  out.set(image, 20);
  return out.buffer;
}

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
    if (cmd === "editor_crop_layers") return new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]).buffer;
    if (cmd === "editor_list_fonts") return ["Arial", "Segoe UI"];
    if (cmd === "editor_render_text") return textFrame();
    if (cmd === "editor_cut_layer") {
      // A 2x1 source's hole, then a 1x1 cutout at layer pixel (1, 0).
      const hole = new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]);
      const cut = new Uint8Array(placedFrame(1, 0, frame(1, 1, 9)));
      const out = new Uint8Array(hole.length + cut.length);
      out.set(hole);
      out.set(cut, hole.length);
      return out.buffer;
    }
    if (cmd === "editor_probe_pasted") return { width: 30, height: 20, exceedsCap: false };
    if (cmd === "editor_apply_effect") return effectFrame([-3, 4.5, 2, 2, 30], frame(1, 1, 6));
    if (cmd === "editor_background_model_status") return { downloaded: false, sizeBytes: 178648008 };
    if (cmd === "editor_download_background_model") {
      (args?.onProgress as { onmessage: (p: unknown) => void }).onmessage({ received: 5, total: 10 });
      return "done";
    }
    if (cmd === "editor_cancel_background_download") return null;
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
const { layerInput } = await import("../src/editor/model/document");

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

test("crop sends one raw body plus a size/transform/clip header, and splits the clips", async () => {
  const t = { x: -1, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  const a = { width: 2, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]) };
  const b = { width: 1, height: 1, pixels: new Uint8ClampedArray([9, 10, 11, 12]) };
  const clipA = { x: 0, y: 0, width: 1, height: 1 };
  const clipB = { x: 3, y: 4, width: 2, height: 1 };
  const out = await api.cropImages([
    { image: a, transform: t, clip: clipA },
    { image: b, transform: { ...t, rotation: 45 }, clip: clipB },
  ]);
  const call = calls[calls.length - 1];
  expect(call.cmd).toBe("editor_crop_layers");
  expect(Array.from(call.args as unknown as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const headers = (options[options.length - 1] as { headers: Record<string, string> }).headers;
  expect(JSON.parse(headers["x-crop-layers"])).toEqual([
    { width: 2, height: 1, transform: t, clip: clipA },
    { width: 1, height: 1, transform: { ...t, rotation: 45 }, clip: clipB },
  ]);
  expect(out.map((i) => [i.width, i.height, ...i.pixels])).toEqual([
    [1, 1, 1, 1, 1, 1],
    [2, 1, 2, 2, 2, 2, 3, 3, 3, 3],
  ]);
});

test("splitClips refuses a response whose size does not match the clips", () => {
  expect(() => api.splitClips(new ArrayBuffer(3), [{ x: 0, y: 0, width: 1, height: 1 }])).toThrow("expected 4");
});

test("merge and crop send text layers as text in the header, with no body bytes", async () => {
  const t = { x: 0, y: 0, scaleX: 2, scaleY: 2, rotation: 0 };
  const raster = { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 4]) };
  const style = { text: "hi", fontFamily: "Arial", fontSize: 30, color: "#112233", outline: null };
  const render = await api.renderText(style);
  await api.mergeImages([{ image: raster, transform: t }, { text: style, render, transform: t }]);
  let call = calls[calls.length - 1];
  expect(Array.from(call.args as unknown as Uint8Array)).toEqual([1, 2, 3, 4]);
  let headers = (options[options.length - 1] as { headers: Record<string, string> }).headers;
  expect(JSON.parse(headers["x-merge-layers"])[1]).toEqual({ width: 3, height: 2, transform: t, text: style });
  const clip = { x: 0, y: 0, width: 1, height: 1 };
  await api.cropImages([{ text: style, render, transform: t, clip }, { image: raster, transform: t, clip }]).catch(() => {});
  call = calls[calls.length - 1];
  expect(call.cmd).toBe("editor_crop_layers");
  expect(Array.from(call.args as unknown as Uint8Array)).toEqual([1, 2, 3, 4]);
  headers = (options[options.length - 1] as { headers: Record<string, string> }).headers;
  expect(JSON.parse(headers["x-crop-layers"])[0]).toEqual({ width: 3, height: 2, transform: t, text: style, clip });
});

test("layerInput turns model layers into merge inputs", () => {
  const image = { width: 1, height: 1, pixels: new Uint8ClampedArray(4) };
  const t = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  expect(layerInput({ kind: "raster", id: "a", name: "a", transform: t, image })).toEqual({ image, transform: t });
  const render = { image, metrics: { originX: 0, originY: 0, ascent: 1, descent: 1, lineHeight: 2 } };
  const text = { kind: "text" as const, id: "b", name: "hi", transform: t, text: "hi", fontFamily: "Arial", fontSize: 9, color: "#000000", outline: null, render };
  expect(layerInput(text)).toEqual({
    text: { text: "hi", fontFamily: "Arial", fontSize: 9, color: "#000000", outline: null },
    render,
    transform: t,
  });
});

test("fonts and text rendering use the Rust commands and decode the metrics frame", async () => {
  expect(await api.listFonts()).toEqual(["Arial", "Segoe UI"]);
  const style = { text: "hi", fontFamily: "Arial", fontSize: 30, color: "#112233", outline: null };
  const render = await api.renderText({ ...style, extra: 1 } as typeof style);
  const call = calls[calls.length - 1];
  expect(call).toEqual({ cmd: "editor_render_text", args: { spec: style } });
  expect(render.metrics).toEqual({ originX: 1.5, originY: 0, ascent: 40, descent: 10, lineHeight: 55 });
  expect([render.image.width, render.image.height]).toEqual([3, 2]);
  expect(() => api.decodeTextFrame(new ArrayBuffer(10))).toThrow("truncated");
});

test("the outline rides the text style onto the wire, and none is null (SPM-18)", async () => {
  const outlined = { text: "hi", fontFamily: "Arial", fontSize: 30, color: "#112233", outline: { color: "#ffffff", width: 8 } };
  await api.renderText(outlined);
  expect(calls[calls.length - 1].args).toEqual({ spec: outlined });
  await api.renderText({ ...outlined, outline: null });
  expect(calls[calls.length - 1].args).toEqual({ spec: { ...outlined, outline: null } });
});

test("cut sends the layer's pixels and a polygon header, and splits the hole from the cutout", async () => {
  // The pixels may be a view into a larger buffer (as decodeFrame returns): only the view is sent.
  const backing = new Uint8ClampedArray(16).fill(99);
  backing.set([1, 2, 3, 4, 5, 6, 7, 8], 8);
  const image = { width: 2, height: 1, pixels: new Uint8ClampedArray(backing.buffer, 8, 8) };
  const t = { x: 3, y: 4, scaleX: 1, scaleY: 1, rotation: 0 };
  const out = await api.cutImage(image, t, [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 1 },
  ]);
  const call = calls[calls.length - 1];
  expect(call.cmd).toBe("editor_cut_layer");
  expect(Array.from(call.args as unknown as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  const headers = (options[options.length - 1] as { headers: Record<string, string> }).headers;
  expect(JSON.parse(headers["x-cut-layer"])).toEqual({
    width: 2,
    height: 1,
    transform: t,
    polygon: [
      [0, 0],
      [2, 0],
      [2, 1],
    ],
  });
  expect(Array.from(out.hole.pixels)).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
  expect([out.x, out.y, out.cutout.width, ...out.cutout.pixels]).toEqual([1, 0, 1, 9, 9, 9, 9]);
  expect(() => api.decodeCutFrame(new ArrayBuffer(4), 2, 1)).toThrow("truncated");
});

test("pasted images are probed and imported from their bytes with the scale-to-fit header", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  expect(await api.probePasted(bytes)).toEqual({ width: 30, height: 20, exceedsCap: false });
  expect(calls[calls.length - 1]).toEqual({ cmd: "editor_probe_pasted", args: bytes as unknown as Record<string, unknown> });
  const img = await api.importPasted(bytes, true);
  expect(calls[calls.length - 1].cmd).toBe("editor_import_pasted");
  expect((options[options.length - 1] as { headers: Record<string, string> }).headers).toEqual({ "x-scale-to-fit": "true" });
  expect([img.width, img.height]).toEqual([2, 1]);
});

test("an effect sends the layer and its settings, and reads the new transform and pixels", async () => {
  const image = { width: 2, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]) };
  const t = { x: 3, y: 4, scaleX: 2, scaleY: 2, rotation: 30 };
  const effect = { kind: "outline", color: "#ffffff", width: 8 } as const;
  const out = await api.applyEffect({ image, transform: t }, effect);
  const call = calls[calls.length - 1];
  expect(call.cmd).toBe("editor_apply_effect");
  expect(Array.from(call.args as unknown as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  const headers = (options[options.length - 1] as { headers: Record<string, string> }).headers;
  expect(JSON.parse(headers["x-effect"])).toEqual({ width: 2, height: 1, transform: t, effect });
  expect(out.transform).toEqual({ x: -3, y: 4.5, scaleX: 2, scaleY: 2, rotation: 30 });
  expect([out.image.width, ...out.image.pixels]).toEqual([1, 6, 6, 6, 6]);
  expect(() => api.decodeEffectFrame(new ArrayBuffer(12))).toThrow("truncated");
});

test("an effect on a text layer sends its text and no body bytes", async () => {
  const style = { text: "Hi", fontFamily: "Impact", fontSize: 64, color: "#000000", outline: null };
  const render = { image: { width: 4, height: 2, pixels: new Uint8ClampedArray(32) }, metrics: { originX: 0, originY: 0, ascent: 1, descent: 1, lineHeight: 2 } };
  const t = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  await api.applyEffect({ text: style, render, transform: t }, { kind: "glow", color: "#ff0000", radius: 5, softness: 0.5, opacity: 1 });
  expect(Array.from(calls[calls.length - 1].args as unknown as Uint8Array)).toEqual([]);
  const headers = (options[options.length - 1] as { headers: Record<string, string> }).headers;
  expect(JSON.parse(headers["x-effect"])).toMatchObject({ width: 4, height: 2, text: style, effect: { kind: "glow" } });
});

test("background removal: model status, download with progress, cancel, and the raw removal request", async () => {
  calls.length = 0;
  options.length = 0;
  expect(await api.backgroundModelStatus()).toEqual({ downloaded: false, sizeBytes: 178648008 });
  const seen: unknown[] = [];
  expect(await api.downloadBackgroundModel((p) => seen.push(p))).toBe("done");
  expect(seen).toEqual([{ received: 5, total: 10 }]);
  await api.cancelBackgroundDownload();
  const layer = { width: 2, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]) };
  const out = await api.removeImageBackground(layer);
  expect(calls.map((c) => c.cmd)).toEqual([
    "editor_background_model_status",
    "editor_download_background_model",
    "editor_cancel_background_download",
    "editor_remove_background",
  ]);
  expect(calls[0].args).toBeUndefined();
  // Rust's parameter is on_progress: Tauri maps the camelCase key.
  expect(Object.keys(calls[1].args ?? {})).toEqual(["onProgress"]);
  expect(Array.from(calls[3].args as unknown as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(options[3]).toEqual({ headers: { [api.REMOVE_BACKGROUND_HEADER]: JSON.stringify({ width: 2, height: 1 }) } });
  expect(api.REMOVE_BACKGROUND_HEADER).toBe("x-remove-background");
  expect(out.width).toBe(2);
  expect(out.height).toBe(1);
});

test("save sends the canvas, layers, format and target in one ASCII header", async () => {
  const { newDocument, addTextLayer } = await import("../src/editor/model/document");
  const image = { width: 2, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]) };
  const style = { text: "café 😀", fontFamily: "Arial", fontSize: 30, color: "#112233", outline: null };
  const render = await api.renderText(style);
  const side = limits.sticker.side;
  let doc = newDocument(image, "base", { width: side, height: 3 });
  doc = addTextLayer(doc, style, render);
  await api.saveImage(doc, "webp", { kind: "append", packId: 4 });
  const call = calls[calls.length - 1];
  expect(call.cmd).toBe("editor_save_image");
  expect(Array.from(call.args as unknown as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  const header = (options[options.length - 1] as { headers: Record<string, string> }).headers["x-save-image"];
  // A header value carries only visible ASCII; the text survives as JSON escapes.
  expect(/^[\x20-\x7e]*$/.test(header)).toBe(true);
  const meta = JSON.parse(header);
  expect([meta.width, meta.height, meta.format, meta.target]).toEqual([side, 3, "webp", { kind: "append", packId: 4 }]);
  expect(meta.layers.length).toBe(2);
  expect(meta.layers[0]).toEqual({ width: 2, height: 1, transform: doc.layers[0].transform });
  expect(meta.layers[1].text).toEqual(style);
});

test("asciiJson escapes every non-ASCII character and means the same JSON", () => {
  const value = { text: "naïve ✓ 👍", n: 1, nested: ["\u007f"] };
  const json = api.asciiJson(value);
  expect(/^[\x20-\x7e]*$/.test(json)).toBe(true);
  expect(JSON.parse(json)).toEqual(value);
  expect(api.asciiJson({ a: "plain" })).toBe(JSON.stringify({ a: "plain" }));
});

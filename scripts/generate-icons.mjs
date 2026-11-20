// Generates the Tauri app icons in src-tauri/icons (PNG set + Windows .ico +
// macOS .icns) from the owner-approved procedural design (SPM-14): a
// Telegram-blue rounded square with a white circular sticker peeling at the
// top-right corner. No image dependencies; run with:
//   node scripts/generate-icons.mjs   (or: bun run icons)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "icons");

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Design -----------------------------------------------------------------

// Returns [r, g, b] for a sample point, or null when outside the icon shape.
// Owner-approved design (SPM-14): Telegram-blue rounded square, white circular
// die-cut sticker, top-right corner peeled up. The removed corner shows the
// background; its mirror image across the fold line x - y = k is the pale
// underside flap lying over the sticker face.
function sample(x, y, size) {
  // Rounded-square background covering the full canvas.
  const r = 0.2 * size;
  const bx = Math.min(Math.max(x, r), size - r);
  const by = Math.min(Math.max(y, r), size - r);
  const dx = x - bx;
  const dy = y - by;
  if (dx * dx + dy * dy > r * r) return null;
  const cx = 0.5 * size;
  const cy = 0.47 * size;
  const sr = 0.3 * size;
  const k = 0.33 * size;
  const inSticker = (x - cx) ** 2 + (y - cy) ** 2 <= sr * sr;
  if (inSticker && x - y > k) return [42, 171, 238]; // peeled-away corner: gap
  if (x - y < k && (y + k - cx) ** 2 + (x - k - cy) ** 2 <= sr * sr) {
    return [214, 233, 245]; // underside flap
  }
  if (inSticker) return [255, 255, 255];
  return [42, 171, 238];
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      // 2x2 supersampling for smooth edges.
      for (const oy of [0.25, 0.75]) {
        for (const ox of [0.25, 0.75]) {
          const c = sample(x + ox, y + oy, size);
          if (c) {
            r += c[0] * 255;
            g += c[1] * 255;
            b += c[2] * 255;
            a += 255;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
        px[i + 3] = Math.round(a / 4);
      }
    }
  }
  return px;
}

// --- Container formats --------------------------------------------------------

// ICO with PNG-compressed entries (supported by Windows Vista and later).
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size; // 0 means 256
    d[1] = e.size >= 256 ? 0 : e.size;
    d.writeUInt16LE(1, 4); // color planes
    d.writeUInt16LE(32, 6); // bits per pixel
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.png.length;
    dir.push(d);
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

// ICNS with PNG payloads (modern macOS icon types).
function encodeIcns(entries) {
  const body = Buffer.concat(
    entries.map((e) => {
      const h = Buffer.alloc(8);
      h.write(e.type, 0, "ascii");
      h.writeUInt32BE(e.png.length + 8, 4);
      return Buffer.concat([h, e.png]);
    }),
  );
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

// --- Generate -----------------------------------------------------------------

const pngs = new Map();
for (const size of [16, 32, 48, 128, 256, 512, 1024]) {
  pngs.set(size, encodePng(size, render(size)));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "32x32.png"), pngs.get(32));
writeFileSync(join(outDir, "128x128.png"), pngs.get(128));
writeFileSync(join(outDir, "128x128@2x.png"), pngs.get(256));
writeFileSync(join(outDir, "icon.png"), pngs.get(512));
writeFileSync(
  join(outDir, "icon.ico"),
  encodeIco([16, 32, 48, 256].map((size) => ({ size, png: pngs.get(size) }))),
);
writeFileSync(
  join(outDir, "icon.icns"),
  encodeIcns([
    { type: "ic07", png: pngs.get(128) },
    { type: "ic08", png: pngs.get(256) },
    { type: "ic09", png: pngs.get(512) },
    { type: "ic10", png: pngs.get(1024) },
  ]),
);
console.log(`Icons written to ${outDir}`);
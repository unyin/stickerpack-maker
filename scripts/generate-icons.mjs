// Generates the Tauri app icons in src-tauri/icons (PNG set + Windows .ico +
// macOS .icns) from the owner-approved procedural design (SPM-34, replacing
// SPM-14's peeling sticker): the Pack Manager "layers" stack (three sheets, as
// in src/icons.ts) as solid white sheets on the Telegram-blue rounded square.
// The top sheet's left corner is peeled back along a fold that runs from the
// upper-left edge, where a vertical line at 1/4 of the horizontal diagonal
// meets it, to a point a third of the way along the lower-left edge, measured
// from where that vertical line meets it toward the bottom corner. The flap is
// a mid-tone underside, with the sheets beneath showing through where the
// corner was. uninstall.ico is the same icon with a glossy red disc and a
// white X at the bottom right, so the uninstaller is told apart from the app.
// No image dependencies; run with:
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

// Telegram blue: the icon background, also the gap between the sheets.
const BLUE = [42, 171, 238];
const WHITE = [255, 255, 255];
// Mid-tone underside of the peeled corner.
const FLAP = [147, 212, 246];

// The sheets are the Pack Manager "layers" stack (src/icons.ts), drawn in its
// 24-unit space and scaled into the rounded square.
const HW = 9; // sheet (diamond) half-width, in units
const HH = 4.5; // sheet half-height
const VIEW_CENTRE = 12; // centre of the 24-unit layers space, on both axes
const CX = VIEW_CENTRE; // horizontal centre of the stack
const TOPY = 7.5; // vertical centre of the top sheet
const STEP = 4.5; // vertical distance between sheet centres (7.5, 12, 16.5)
const GAP = 1.25; // blue separation between sheets, perpendicular, in units
const SCALE = 0.04; // size fraction per unit: 18 units span 72% of the square
const NORM = Math.sqrt(1 / HW ** 2 + 1 / HH ** 2);
// The peel: the top sheet's left corner folds back along a line that starts
// PEEL_FRAC of the way along the horizontal diagonal, on the upper-left edge,
// and ends PEEL_TILT of the way ALONG the lower-left edge, from where the
// vertical PEEL_FRAC line meets that edge, toward the bottom corner.
const PEEL_FRAC = 0.25;
const PEEL_TILT = 1 / 3;

// Uninstaller badge, in canvas fractions: a glossy red disc at the bottom right.
const BADGE_X = 0.75;
const BADGE_Y = 0.75;
const BADGE_R = 0.22;
const RED_TOP = [245, 80, 70];
const RED_BOTTOM = [165, 18, 18];
// Gloss highlight: an ellipse (centre offset and radii in badge radii) whitened by up to HIGHLIGHT_STRENGTH.
const HIGHLIGHT_DX = 0.05; // (u + DX) / RX, i.e. centred at u = -0.05
const HIGHLIGHT_DY = 0.48; // (v + DY) / RY, i.e. centred at v = -0.48
const HIGHLIGHT_RX = 0.62;
const HIGHLIGHT_RY = 0.34;
const HIGHLIGHT_STRENGTH = 0.55;
// The badge's white X: arms run corner to corner of a square of this half-side, stroked this thick (half-width).
const X_HALF_LENGTH = 0.42;
const X_HALF_WIDTH = 0.13;

const SS = 4; // 4x4 supersampling for smooth edges

const mix = (a, b, s) => a.map((v, i) => v + (b[i] - v) * s);
const val = (x, y, cy) => Math.abs(x - CX) / HW + Math.abs(y - cy) / HH;
const inSheet = (x, y, cy) => val(x, y, cy) <= 1;
const inBand = (x, y, cy) => (val(x, y, cy) - 1) / NORM <= GAP; // sheet grown by GAP

// The peel's fold line, in layers units (depends only on the constants above).
const FOLD_LEFT_X = CX - HW + PEEL_FRAC * 2 * HW; // x of the vertical PEEL_FRAC line
const FOLD_HALF_RISE = (FOLD_LEFT_X - (CX - HW)) * (HH / HW); // rise of each left edge at the vertical line, above and below TOPY
const FOLD_TOP = [FOLD_LEFT_X, TOPY - FOLD_HALF_RISE]; // fold top end, on the upper-left edge
const VERTICAL_FOLD_BOTTOM = [FOLD_LEFT_X, TOPY + FOLD_HALF_RISE]; // on the lower-left edge
const BOTTOM_CORNER = [CX, TOPY + HH];
const FOLD_BOTTOM = [
  VERTICAL_FOLD_BOTTOM[0] + PEEL_TILT * (BOTTOM_CORNER[0] - VERTICAL_FOLD_BOTTOM[0]),
  VERTICAL_FOLD_BOTTOM[1] + PEEL_TILT * (BOTTOM_CORNER[1] - VERTICAL_FOLD_BOTTOM[1]),
]; // fold bottom end
const FOLD_DX = FOLD_BOTTOM[0] - FOLD_TOP[0];
const FOLD_DY = FOLD_BOTTOM[1] - FOLD_TOP[1];
const FOLD_LEN = Math.hypot(FOLD_DX, FOLD_DY);
const FOLD_NX = -FOLD_DY / FOLD_LEN;
const FOLD_NY = FOLD_DX / FOLD_LEN; // unit normal of the fold line
const signedDistToFold = (x, y) => (x - FOLD_TOP[0]) * FOLD_NX + (y - FOLD_TOP[1]) * FOLD_NY;
const CORNER_SIDE = Math.sign(signedDistToFold(CX - HW, TOPY));
const onCornerSide = (x, y) => Math.sign(signedDistToFold(x, y)) === CORNER_SIDE;

const MIDDLE_SHEET_Y = TOPY + STEP;
const BOTTOM_SHEET_Y = TOPY + 2 * STEP;

// Colour at content point (x, y), in layers units.
function content(x, y) {
  // Flap: reflect across the fold; a point is flap if its mirror is a removed point.
  const d = signedDistToFold(x, y);
  const mx = x - 2 * d * FOLD_NX;
  const my = y - 2 * d * FOLD_NY;
  if (!onCornerSide(x, y) && inSheet(mx, my, TOPY) && onCornerSide(mx, my)) return FLAP;
  const removed = inSheet(x, y, TOPY) && onCornerSide(x, y);
  if (!removed) {
    if (inSheet(x, y, TOPY)) return WHITE;
    if (inBand(x, y, TOPY) && !onCornerSide(x, y)) return BLUE;
  }
  // Removed corner: whatever lies beneath shows through (the sheets below, else the background).
  if (inSheet(x, y, MIDDLE_SHEET_Y)) return WHITE;
  if (inBand(x, y, MIDDLE_SHEET_Y)) return BLUE;
  if (inSheet(x, y, BOTTOM_SHEET_Y)) return WHITE;
  return BLUE;
}

// Returns [r, g, b] for a sample point, or null when outside the icon shape.
function sample(x, y, size) {
  // Rounded-square background covering the full canvas.
  const r = 0.2 * size;
  const bx = Math.min(Math.max(x, r), size - r);
  const by = Math.min(Math.max(y, r), size - r);
  if ((x - bx) ** 2 + (y - by) ** 2 > r * r) return null;
  const layersX = (x - size / 2) / (SCALE * size) + VIEW_CENTRE;
  const layersY = (y - size / 2) / (SCALE * size) + VIEW_CENTRE;
  return content(layersX, layersY);
}

function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

// Distance to an X whose arms run corner to corner of a square of half-side `half`.
function xDist(u, v, half) {
  return Math.min(segDist(u, v, -half, -half, half, half), segDist(u, v, -half, half, half, -half));
}

// Glossy red: darker toward the bottom, plus a soft highlight ellipse in the upper part.
function gloss(u, v) {
  let c = mix(RED_TOP, RED_BOTTOM, (v + 1) / 2);
  const h = ((u + HIGHLIGHT_DX) / HIGHLIGHT_RX) ** 2 + ((v + HIGHLIGHT_DY) / HIGHLIGHT_RY) ** 2;
  if (h < 1) c = mix(c, WHITE, HIGHLIGHT_STRENGTH * (1 - h));
  return c;
}

// Badge colour at (u, v), in badge radii from its centre, or null outside the disc.
function badge(u, v) {
  if (Math.hypot(u, v) > 1) return null;
  return xDist(u, v, X_HALF_LENGTH) <= X_HALF_WIDTH ? WHITE : gloss(u, v);
}

function render(size, withBadge) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const sx = x + (i + 0.5) / SS;
          const sy = y + (j + 0.5) / SS;
          let badgeColour = null;
          if (withBadge) {
            const u = (sx / size - BADGE_X) / BADGE_R;
            const v = (sy / size - BADGE_Y) / BADGE_R;
            badgeColour = badge(u, v);
          }
          const c = badgeColour || sample(sx, sy, size);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a++;
          }
        }
      }
      const k = (y * size + x) * 4;
      if (a > 0) {
        pixels[k] = Math.round(r / a);
        pixels[k + 1] = Math.round(g / a);
        pixels[k + 2] = Math.round(b / a);
        pixels[k + 3] = Math.round((255 * a) / (SS * SS));
      }
    }
  }
  return pixels;
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

const ICO_SIZES = [16, 32, 48, 256];
const icoEntries = (images) => ICO_SIZES.map((size) => ({ size, png: images.get(size) }));

const pngs = new Map();
const badged = new Map(); // uninstaller icon: only the sizes its .ico holds
for (const size of [16, 32, 48, 128, 256, 512, 1024]) {
  pngs.set(size, encodePng(size, render(size, false)));
  if (ICO_SIZES.includes(size)) badged.set(size, encodePng(size, render(size, true)));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "32x32.png"), pngs.get(32));
writeFileSync(join(outDir, "128x128.png"), pngs.get(128));
writeFileSync(join(outDir, "128x128@2x.png"), pngs.get(256));
writeFileSync(join(outDir, "icon.png"), pngs.get(512));
writeFileSync(join(outDir, "icon.ico"), encodeIco(icoEntries(pngs)));
writeFileSync(join(outDir, "uninstall.ico"), encodeIco(icoEntries(badged)));
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
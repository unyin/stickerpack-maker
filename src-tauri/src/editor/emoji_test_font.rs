//! A synthetic COLOUR TrueType font for the SPM-20 emoji tests: "Test
//! Emoji", a COLRv0 + CPAL emoji face, deterministic on every machine and
//! licence-free like Test Sans.
//!
//! Glyphs (units per em 1000): gid1 '😀' a face box x 100..900, y 100..900;
//! gid2 the background box x -100..1100, y -300..900 (inks beyond the
//! advance horizontally AND past a text font's line box vertically at an
//! em size, so the box-growth test sees ink the layout box does not
//! contain); gid3 '❤' a heart box x 200..800, y 200..800; gid4 '5' a box
//! x 100..900, y 0..700 — every one a colour glyph, the digit included,
//! which pins the routing rule: a bare '5' still draws from the TEXT side
//! because digits are text presentation.
//!
//! COLRv0: 😀 and ❤ are two layers (green background, red top); '5' is a
//! single green layer. Palette 0: [green, red] (CPAL stores BGRA).

pub const FAMILY: &str = "Test Emoji";

struct Glyph {
    advance: u16,
    /// (x_min, y_min, x_max, y_max) of a single rectangular contour.
    rect: (i16, i16, i16, i16),
}

const GLYPHS: [Glyph; 5] = [
    Glyph { advance: 700, rect: (0, 0, 0, 0) },                        // 0 .notdef
    Glyph { advance: 1000, rect: (100, 100, 900, 900) },               // 1 '😀' face
    Glyph { advance: 1000, rect: (-100, -300, 1100, 900) },          // 2 background
    Glyph { advance: 1000, rect: (200, 200, 800, 800) },               // 3 '❤' heart
    Glyph { advance: 1000, rect: (100, 0, 900, 700) },                 // 4 '5' five
];

/// Base glyph id -> (first layer index, layer count), ascending by glyph.
const BASE: [(u16, u16, u16); 3] = [(1, 0, 2), (3, 2, 2), (4, 4, 1)];

/// Layer records: (glyph id, palette index), painted in order.
const LAYERS: [(u16, u16); 5] = [(2, 0), (1, 1), (2, 0), (3, 1), (2, 0)];

/// (character, glyph id), ascending: '5', '❤', '😀' (non-BMP, so the cmap
/// subtable is format 12).
const CMAP: [(u32, u16); 3] = [(0x35, 4), (0x2764, 3), (0x1F600, 1)];

/// CPAL palette 0: green then red, BGRA.
const PALETTE: [[u8; 4]; 2] = [[0x00, 0xFF, 0x00, 0xFF], [0x00, 0x00, 0xFF, 0xFF]];

fn u16be(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn i16be(out: &mut Vec<u8>, v: i16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn u32be(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn head() -> Vec<u8> {
    let mut t = Vec::new();
    u32be(&mut t, 0x0001_0000); // version
    u32be(&mut t, 0x0001_0000); // fontRevision
    u32be(&mut t, 0); // checkSumAdjustment
    u32be(&mut t, 0x5F0F_3CF5); // magicNumber
    u16be(&mut t, 0x000B); // flags
    u16be(&mut t, 1000); // unitsPerEm
    t.extend_from_slice(&[0; 16]); // created, modified
    for v in [-100i16, -300, 1100, 900] {
        i16be(&mut t, v); // xMin, yMin, xMax, yMax
    }
    u16be(&mut t, 0); // macStyle
    u16be(&mut t, 8); // lowestRecPPEM
    i16be(&mut t, 2); // fontDirectionHint
    i16be(&mut t, 1); // indexToLocFormat: long offsets
    i16be(&mut t, 0); // glyphDataFormat
    t
}

fn hhea() -> Vec<u8> {
    let mut t = Vec::new();
    u32be(&mut t, 0x0001_0000);
    i16be(&mut t, 800); // ascender
    i16be(&mut t, -200); // descender
    i16be(&mut t, 0); // lineGap
    u16be(&mut t, 1000); // advanceWidthMax
    i16be(&mut t, -100); // minLeftSideBearing
    i16be(&mut t, 100); // minRightSideBearing
    i16be(&mut t, 1100); // xMaxExtent
    i16be(&mut t, 1); // caretSlopeRise
    i16be(&mut t, 0); // caretSlopeRun
    i16be(&mut t, 0); // caretOffset
    t.extend_from_slice(&[0; 8]); // reserved
    i16be(&mut t, 0); // metricDataFormat
    u16be(&mut t, GLYPHS.len() as u16); // numberOfHMetrics
    t
}

fn maxp() -> Vec<u8> {
    let mut t = Vec::new();
    u32be(&mut t, 0x0000_5000);
    u16be(&mut t, GLYPHS.len() as u16);
    t
}

fn hmtx() -> Vec<u8> {
    let mut t = Vec::new();
    for g in &GLYPHS {
        u16be(&mut t, g.advance);
        i16be(&mut t, g.rect.0);
    }
    t
}

/// glyf and loca (long offsets) together; .notdef carries an empty contour.
fn glyf_loca() -> (Vec<u8>, Vec<u8>) {
    let (mut glyf, mut loca) = (Vec::new(), Vec::new());
    for g in &GLYPHS {
        u32be(&mut loca, glyf.len() as u32);
        let (x0, y0, x1, y1) = g.rect;
        if x0 == 0 && y0 == 0 && x1 == 0 && y1 == 0 {
            continue; // .notdef: no outline
        }
        i16be(&mut glyf, 1); // numberOfContours
        for v in [x0, y0, x1, y1] {
            i16be(&mut glyf, v);
        }
        u16be(&mut glyf, 3); // endPtsOfContours[0]
        u16be(&mut glyf, 0); // instructionLength
        glyf.extend_from_slice(&[1, 1, 1, 1]); // on-curve, 16-bit deltas
        for dx in [x0, 0, x1 - x0, 0] {
            i16be(&mut glyf, dx);
        }
        for dy in [y0, y1 - y0, 0, y0 - y1] {
            i16be(&mut glyf, dy);
        }
        while glyf.len() % 4 != 0 {
            glyf.push(0);
        }
    }
    u32be(&mut loca, glyf.len() as u32);
    (glyf, loca)
}

/// cmap with one (3, 10) format 12 subtable: constant groups.
fn cmap() -> Vec<u8> {
    let mut sub = Vec::new();
    u16be(&mut sub, 12); // format
    u16be(&mut sub, 0); // reserved
    u32be(&mut sub, 16 + 12 * CMAP.len() as u32); // length
    u32be(&mut sub, 0); // language
    u32be(&mut sub, CMAP.len() as u32); // numGroups
    for &(start, gid) in &CMAP {
        u32be(&mut sub, start); // startCharCode
        u32be(&mut sub, start); // endCharCode
        u32be(&mut sub, gid as u32); // startGlyphID
    }
    let mut t = Vec::new();
    u16be(&mut t, 0); // version
    u16be(&mut t, 1); // numTables
    u16be(&mut t, 3); // platform Windows
    u16be(&mut t, 10); // Unicode full
    u32be(&mut t, 12); // offset
    t.extend_from_slice(&sub);
    t
}

/// COLR v0: base glyph records then layer records.
fn colr() -> Vec<u8> {
    let mut t = Vec::new();
    u16be(&mut t, 0); // version
    u16be(&mut t, BASE.len() as u16); // numBaseGlyphRecords
    let base_offset = 14u32; // after this header
    let layer_offset = base_offset + 6 * BASE.len() as u32;
    u32be(&mut t, base_offset);
    u32be(&mut t, layer_offset);
    u16be(&mut t, LAYERS.len() as u16); // numLayerRecords
    for &(gid, first, count) in &BASE {
        u16be(&mut t, gid);
        u16be(&mut t, first);
        u16be(&mut t, count);
    }
    for &(gid, palette) in &LAYERS {
        u16be(&mut t, gid);
        u16be(&mut t, palette);
    }
    t
}

/// CPAL v0 with one palette of the fixed colours (BGRA records).
fn cpal() -> Vec<u8> {
    let mut t = Vec::new();
    u16be(&mut t, 0); // version
    u16be(&mut t, PALETTE.len() as u16); // numPaletteEntries
    u16be(&mut t, 1); // numPalettes
    u16be(&mut t, PALETTE.len() as u16); // numColorRecords
    u32be(&mut t, 12 + 2); // offsetToFirstColorRecord (after the one index)
    u16be(&mut t, 0); // colorRecordIndices[0]
    for [b, g, r, a] in PALETTE {
        t.extend_from_slice(&[b, g, r, a]);
    }
    t
}

/// name table: family, subfamily, full name and PostScript name (en-US).
fn name() -> Vec<u8> {
    let records: [(u16, &str); 4] =
        [(1, FAMILY), (2, "Regular"), (4, "Test Emoji Regular"), (6, "TestEmoji-Regular")];
    let encoded: Vec<Vec<u8>> =
        records.iter().map(|(_, s)| s.encode_utf16().flat_map(u16::to_be_bytes).collect()).collect();
    let mut t = Vec::new();
    u16be(&mut t, 0); // format
    u16be(&mut t, records.len() as u16);
    u16be(&mut t, 6 + 12 * records.len() as u16); // stringOffset
    let mut offset = 0u16;
    for ((id, _), bytes) in records.iter().zip(&encoded) {
        for v in [3, 1, 0x409, *id, bytes.len() as u16, offset] {
            u16be(&mut t, v);
        }
        offset += bytes.len() as u16;
    }
    for bytes in &encoded {
        t.extend_from_slice(bytes);
    }
    t
}

/// The font file's bytes.
pub fn bytes() -> Vec<u8> {
    let (glyf, loca) = glyf_loca();
    let mut tables: Vec<(&[u8; 4], Vec<u8>)> = vec![
        (b"COLR", colr()),
        (b"CPAL", cpal()),
        (b"cmap", cmap()),
        (b"glyf", glyf),
        (b"head", head()),
        (b"hhea", hhea()),
        (b"hmtx", hmtx()),
        (b"loca", loca),
        (b"maxp", maxp()),
        (b"name", name()),
    ];
    tables.sort_by_key(|(tag, _)| **tag);
    let mut font = Vec::new();
    u32be(&mut font, 0x0001_0000); // sfnt version: TrueType
    u16be(&mut font, tables.len() as u16);
    font.extend_from_slice(&[0; 6]); // searchRange, entrySelector, rangeShift
    let mut offset = 12 + 16 * tables.len();
    let mut body = Vec::new();
    for (tag, data) in &tables {
        font.extend_from_slice(*tag);
        u32be(&mut font, 0); // checksum (not verified by readers)
        u32be(&mut font, offset as u32);
        u32be(&mut font, data.len() as u32);
        let mut padded = data.clone();
        while padded.len() % 4 != 0 {
            padded.push(0);
        }
        offset += padded.len();
        body.extend_from_slice(&padded);
    }
    font.extend_from_slice(&body);
    font
}

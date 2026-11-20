//! A tiny synthetic TrueType font for the text tests: deterministic on every
//! machine (no system fonts, no licence questions), with glyphs that are
//! plain rectangles, so tests can predict exactly which pixels are inked.
//!
//! Metrics (units per em 1000): ascender 800, descender -200, line gap 100.
//! Glyphs: ' ' advance 300 (no outline); 'A' a box x 100..500, y 0..700,
//! advance 600; 'g' a box x 100..400, y -200..300, advance 500; 'j' a box
//! x -100..200, y -200..500 (ink left of the pen), advance 300. Every
//! other character maps to .notdef (glyph 0, no outline, advance 500).

pub const FAMILY: &str = "Test Sans";

struct Glyph {
    advance: u16,
    /// (x_min, y_min, x_max, y_max) of a single rectangular contour.
    rect: Option<(i16, i16, i16, i16)>,
}

const GLYPHS: [Glyph; 5] = [
    Glyph { advance: 500, rect: None },                       // 0 .notdef
    Glyph { advance: 600, rect: Some((100, 0, 500, 700)) },   // 1 'A'
    Glyph { advance: 300, rect: None },                       // 2 ' '
    Glyph { advance: 500, rect: Some((100, -200, 400, 300)) }, // 3 'g'
    Glyph { advance: 300, rect: Some((-100, -200, 200, 500)) }, // 4 'j'
];

/// (character, glyph id), ascending by character.
const CMAP: [(u16, u16); 4] = [(32, 2), (65, 1), (103, 3), (106, 4)];

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
    for v in [-100i16, -200, 500, 700] {
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
    i16be(&mut t, 100); // lineGap
    u16be(&mut t, 600); // advanceWidthMax
    i16be(&mut t, -100); // minLeftSideBearing
    i16be(&mut t, 0); // minRightSideBearing
    i16be(&mut t, 500); // xMaxExtent
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
    u32be(&mut t, 0x0000_5000); // version 0.5: just the glyph count
    u16be(&mut t, GLYPHS.len() as u16);
    t
}

fn hmtx() -> Vec<u8> {
    let mut t = Vec::new();
    for g in &GLYPHS {
        u16be(&mut t, g.advance);
        i16be(&mut t, g.rect.map_or(0, |r| r.0));
    }
    t
}

/// glyf and loca (long offsets) together.
fn glyf_loca() -> (Vec<u8>, Vec<u8>) {
    let (mut glyf, mut loca) = (Vec::new(), Vec::new());
    for g in &GLYPHS {
        u32be(&mut loca, glyf.len() as u32);
        let Some((x0, y0, x1, y1)) = g.rect else { continue };
        i16be(&mut glyf, 1); // numberOfContours
        for v in [x0, y0, x1, y1] {
            i16be(&mut glyf, v);
        }
        u16be(&mut glyf, 3); // endPtsOfContours[0]
        u16be(&mut glyf, 0); // instructionLength
        glyf.extend_from_slice(&[1, 1, 1, 1]); // on-curve, 16-bit deltas
        // Clockwise: (x0,y0) (x0,y1) (x1,y1) (x1,y0), as deltas.
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

/// cmap with one Windows Unicode BMP (3, 1) format 4 subtable.
fn cmap() -> Vec<u8> {
    let seg_count = CMAP.len() as u16 + 1; // plus the final 0xFFFF segment
    let mut sub = Vec::new();
    u16be(&mut sub, 4); // format
    u16be(&mut sub, 16 + 8 * seg_count); // length
    u16be(&mut sub, 0); // language
    u16be(&mut sub, seg_count * 2);
    sub.extend_from_slice(&[0; 6]); // searchRange, entrySelector, rangeShift (unused)
    for &(c, _) in &CMAP {
        u16be(&mut sub, c); // endCode
    }
    u16be(&mut sub, 0xFFFF);
    u16be(&mut sub, 0); // reservedPad
    for &(c, _) in &CMAP {
        u16be(&mut sub, c); // startCode
    }
    u16be(&mut sub, 0xFFFF);
    for &(c, g) in &CMAP {
        u16be(&mut sub, g.wrapping_sub(c)); // idDelta
    }
    u16be(&mut sub, 1);
    sub.extend_from_slice(&vec![0; 2 * seg_count as usize]); // idRangeOffset
    let mut t = Vec::new();
    u16be(&mut t, 0); // version
    u16be(&mut t, 1); // numTables
    u16be(&mut t, 3); // platform Windows
    u16be(&mut t, 1); // Unicode BMP
    u32be(&mut t, 12); // offset
    t.extend_from_slice(&sub);
    t
}

/// name table: family, subfamily, full name and PostScript name (en-US).
fn name() -> Vec<u8> {
    let records: [(u16, &str); 4] =
        [(1, FAMILY), (2, "Regular"), (4, "Test Sans Regular"), (6, "TestSans-Regular")];
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

/// A font database holding only the test font.
pub fn database() -> fontdb::Database {
    let mut db = fontdb::Database::new();
    db.load_font_data(bytes());
    db
}

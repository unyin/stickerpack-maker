//! Synthetic BITMAP TrueType fonts for the SPM-69 emoji tests: "Test Bitmap
//! Emoji", deterministic on every machine and licence-free like Test Sans and
//! Test Emoji. There are two, because the two bitmap tables ttf-parser reads
//! as PNG are two different containers for the same kind of ink:
//!
//! * `bytes()` — a two-strike CBLC/CBDT face, the colour-bitmap path.
//! * `sbix_bytes()` — a one-strike `sbix` face, Apple's bitmap path, with no
//!   CBLC/CBDT at all: ttf-parser asks `sbix` before CBDT, so a font carrying
//!   both could never pin the sbix one.
//!
//! Both share the glyph set (units per em 1000): gid1 '😀', advance 1000,
//! carries the bitmaps; every other character maps to .notdef (advance 500,
//! no bitmap). Neither font has outlines or COLR layers at all: they are
//! colour-covered by their bitmaps alone, which is the SPM-69 case (a
//! bitmap-only emoji font that used to lose every run).
//!
//! The CBDT face's strikes declare their metrics in CBDT format 17 (PNG with
//! small metrics — `horiBearingX` is the image's left edge from the pen,
//! `horiBearingY` the baseline-to-top height, so the image's BOTTOM edge sits
//! `horiBearingY - height` above the baseline):
//!
//! * 32 ppem: a 32x32 GREEN image 8 px right of the pen with its bottom edge
//!   4 px above the baseline (bearingX 8, bearingY 36) — the offset strike
//!   tests place by.
//! * 96 ppem: a 96x96 RED image flush with the pen, its bottom edge on the
//!   baseline (bearingX 0, bearingY 96).
//!
//! The sbix face has ONE strike, 64 ppem, a 16x16 BLUE image 4 px right of
//! the pen with its bottom edge 2 px above the baseline — the same left edge
//! and bottom edge the CBDT strikes state, in sbix's own terms (the glyph
//! record's `originOffsetX` and `originOffsetY`).
//!
//! The PNG payloads are hand-built and carry their rows as uncompressed
//! ("stored") deflate, so no encoder sits in the test path and the bytes are
//! the same everywhere.

pub const FAMILY: &str = "Test Bitmap Emoji";

/// The font's only bitmap glyph.
const GLYPH: u16 = 1;

/// The font size is the em size, so '😀' advances a full em.
const ADVANCE: u16 = 1000;

struct Strike {
    /// The strike's pixels per em: what `glyph_raster_image` selects on.
    ppem: u16,
    /// The bitmap's side in px (the fixture's images are square).
    side: u8,
    /// The image's left edge from the pen origin: CBDT's `horiBearingX`,
    /// sbix's `originOffsetX`.
    bearing_x: i8,
    /// The image's BOTTOM edge above the baseline (bearingY - height): the
    /// same edge sbix states as `originOffsetY`.
    bottom: i8,
    /// The solid colour the strike's PNG paints.
    color: [u8; 3],
}

const STRIKES: [Strike; 2] = [
    Strike { ppem: 32, side: 32, bearing_x: 8, bottom: 4, color: [0, 255, 0] },
    Strike { ppem: 96, side: 96, bearing_x: 0, bottom: 0, color: [255, 0, 0] },
];

/// The sbix face's single strike. Its colour is neither of the CBDT face's,
/// so a painted pixel says which fixture (and which table) drew it.
const SBIX_STRIKE: Strike = Strike { ppem: 64, side: 16, bearing_x: 4, bottom: 2, color: [0, 0, 255] };

struct Glyph {
    advance: u16,
}

const GLYPHS: [Glyph; 2] = [
    Glyph { advance: 500 }, // 0 .notdef: no bitmap, the text chain's fallback
    Glyph { advance: ADVANCE }, // 1 '😀'
];

/// (character, glyph id), ascending: '😀' is non-BMP, so the cmap subtable
/// is format 12.
const CMAP: [(u32, u16); 1] = [(0x1F600, 1)];

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
    for v in [0i16, -200, 1000, 800] {
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
    i16be(&mut t, 0); // minLeftSideBearing
    i16be(&mut t, 0); // minRightSideBearing
    i16be(&mut t, 1000); // xMaxExtent
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
        i16be(&mut t, 0); // leftSideBearing: the bitmaps carry their own offsets
    }
    t
}

/// `loca` only: the font has no outlines (a bitmap-only emoji face), so every
/// glyph's range is empty. `glyf` is written as an empty table beside it.
fn loca() -> Vec<u8> {
    let mut t = Vec::new();
    for _ in 0..=GLYPHS.len() {
        u32be(&mut t, 0);
    }
    t
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

/// name table: family, subfamily, full name and PostScript name (en-US).
fn name() -> Vec<u8> {
    let records: [(u16, &str); 4] =
        [(1, FAMILY), (2, "Regular"), (4, "Test Bitmap Emoji Regular"), (6, "TestBitmapEmoji-Regular")];
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

/// PNG's CRC-32 (the zlib polynomial) over a chunk's tag and data.
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { 0xEDB8_8320 ^ (crc >> 1) } else { crc >> 1 };
        }
    }
    !crc
}

/// zlib's Adler-32 over the decompressed bytes.
fn adler32(bytes: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in bytes {
        a = (a + u32::from(byte)) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

/// Append one PNG chunk: length, tag, data, CRC-32 of tag and data.
fn chunk(png: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
    u32be(png, data.len() as u32);
    let mut crc_input = tag.to_vec();
    crc_input.extend_from_slice(data);
    png.extend_from_slice(tag);
    png.extend_from_slice(data);
    u32be(png, crc32(&crc_input));
}

/// A solid-colour 8-bit RGB PNG, `width` x `height`, built by hand: every row
/// is a "none" filter byte then the colour, and the IDAT carries them as
/// uncompressed deflate blocks (a stored block holds at most 65535 bytes, and
/// the widest strike here is 96 * (1 + 3 * 96) = 27744).
fn solid_png(width: usize, height: usize, [r, g, b]: [u8; 3]) -> Vec<u8> {
    // A row is a "none" filter byte then the colour, and every row is alike.
    let mut row = vec![0u8; 1 + width * 3];
    for pixel in row[1..].chunks_mut(3) {
        pixel.copy_from_slice(&[r, g, b]);
    }
    let raw = row.repeat(height);
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::new();
    u32be(&mut ihdr, width as u32);
    u32be(&mut ihdr, height as u32);
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // bit depth 8, truecolour RGB, no interlace
    chunk(&mut png, b"IHDR", &ihdr);
    // zlib: a deflate stream of stored blocks, then Adler-32 of the raw bytes.
    let mut zlib = vec![0x78, 0x01]; // 32K window, no preset dictionary
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, block) in blocks.iter().enumerate() {
        zlib.push(u8::from(i + 1 == blocks.len())); // BFINAL, BTYPE 00 (stored)
        zlib.extend_from_slice(&(block.len() as u16).to_le_bytes()); // LEN
        zlib.extend_from_slice(&(!(block.len() as u16)).to_le_bytes()); // NLEN
        zlib.extend_from_slice(block);
    }
    u32be(&mut zlib, adler32(&raw));
    chunk(&mut png, b"IDAT", &zlib);
    chunk(&mut png, b"IEND", &[]);
    png
}

/// CBDT: the two strikes' glyph records (format 17 — small metrics, a u32
/// length and a PNG), each at its own offset from the table's start. Returns
/// the table and those offsets, which CBLC's index subtables point at.
fn cbdt() -> (Vec<u8>, Vec<u32>) {
    let mut t = Vec::new();
    u32be(&mut t, 0x0003_0000); // version 3.0
    let mut offsets = Vec::with_capacity(STRIKES.len());
    for strike in &STRIKES {
        offsets.push(t.len() as u32);
        let png = solid_png(strike.side as usize, strike.side as usize, strike.color);
        t.push(strike.side); // height
        t.push(strike.side); // width
        t.push(strike.bearing_x as u8); // horiBearingX
        t.push((i16::from(strike.bottom) + i16::from(strike.side)) as u8); // horiBearingY
        t.push(strike.side); // horiAdvance (the vertical metrics are unused)
        u32be(&mut t, png.len() as u32);
        t.extend_from_slice(&png);
    }
    (t, offsets)
}

/// CBLC: one 48-byte BitmapSize record per strike, each followed by its
/// indexSubTableArray (one 8-byte record) and a format-1 index subtable
/// (8-byte header plus one u32 glyph offset). Every strike holds the single
/// glyph `GLYPH`, and the glyph's offset inside its strike is 0, so the
/// subtable's `imageDataOffset` is the glyph record's CBDT offset itself.
fn cblc(image_offsets: &[u32]) -> Vec<u8> {
    const RECORD: usize = 48;
    const ARRAY: usize = 8;
    const SUBTABLE: usize = 12;
    let base = 8 + RECORD * STRIKES.len();
    let arrays: Vec<usize> = (0..STRIKES.len()).map(|i| base + i * (ARRAY + SUBTABLE)).collect();
    let mut t = Vec::new();
    u32be(&mut t, 0x0003_0000); // version 3.0
    u32be(&mut t, STRIKES.len() as u32); // numSizes
    for (i, strike) in STRIKES.iter().enumerate() {
        u32be(&mut t, arrays[i] as u32); // indexSubTableArrayOffset
        u32be(&mut t, SUBTABLE as u32); // indexTablesSize
        u32be(&mut t, 1); // numberOfIndexSubTables
        u32be(&mut t, 0); // colorRef
        t.extend_from_slice(&[0; 24]); // hori and vert sbitLineMetrics
        u16be(&mut t, GLYPH); // startGlyphIndex
        u16be(&mut t, GLYPH); // endGlyphIndex
        t.push(strike.ppem as u8); // ppemX
        t.push(strike.ppem as u8); // ppemY
        t.push(32); // bitDepth (unused by the PNG formats)
        t.push(1); // flags: horizontal metrics
    }
    assert_eq!(t.len(), arrays[0], "the BitmapSize records come first");
    for (i, _) in STRIKES.iter().enumerate() {
        u16be(&mut t, GLYPH); // firstGlyphIndex
        u16be(&mut t, GLYPH); // lastGlyphIndex
        u32be(&mut t, ARRAY as u32); // additionalOffsetToIndexSubtable
        u16be(&mut t, 1); // indexFormat 1: a u32 offset per glyph
        u16be(&mut t, 17); // imageFormat 17: PNG with small metrics
        u32be(&mut t, image_offsets[i]); // glyph records' start in CBDT
        u32be(&mut t, 0); // the single glyph's offset from that start
    }
    t
}

/// The font file's bytes.
pub fn bytes() -> Vec<u8> {
    let (cbdt, offsets) = cbdt();
    sfnt(vec![
        (b"CBDT", cbdt),
        (b"CBLC", cblc(&offsets)),
        (b"cmap", cmap()),
        (b"glyf", Vec::new()), // no outlines: the bitmaps are the glyph
        (b"head", head()),
        (b"hhea", hhea()),
        (b"hmtx", hmtx()),
        (b"loca", loca()),
        (b"maxp", maxp()),
        (b"name", name()),
    ])
}

/// sbix: one strike, `SBIX_STRIKE`, holding the single glyph's PNG. The
/// strike's glyph offsets run from the strike's own start — one per glyph plus
/// a final end offset, so equal neighbours mean "no image". Glyph 0 (notdef)
/// keeps two equal offsets, which is how an uncovered character sends the
/// chain on to its next source.
fn sbix() -> Vec<u8> {
    let strike = &SBIX_STRIKE;
    let mut glyph = Vec::new();
    i16be(&mut glyph, i16::from(strike.bearing_x)); // originOffsetX
    i16be(&mut glyph, i16::from(strike.bottom)); // originOffsetY
    glyph.extend_from_slice(b"png "); // graphicType
    glyph.extend_from_slice(&solid_png(strike.side as usize, strike.side as usize, strike.color));
    let start = 4 + 4 * (GLYPHS.len() + 1); // past pixelsPerEm, ppi and the offsets
    let mut data = Vec::new();
    u16be(&mut data, strike.ppem); // pixelsPerEm
    u16be(&mut data, 72); // ppi (the painter never reads it)
    u32be(&mut data, start as u32); // glyph 0: no image (start == end)
    u32be(&mut data, start as u32); // glyph 1: the PNG record starts here
    u32be(&mut data, (start + glyph.len()) as u32); // the end of the last record
    data.extend_from_slice(&glyph);
    let mut t = Vec::new();
    u16be(&mut t, 1); // version
    u16be(&mut t, 0); // flags
    u32be(&mut t, 1); // numStrikes
    u32be(&mut t, 12); // the single strike's offset, past the 8-byte header and this entry
    t.extend_from_slice(&data);
    t
}

/// The sbix font file's bytes: the CBDT face's scaffolding with an `sbix`
/// table in place of CBLC/CBDT, which is what a real sbix emoji font looks
/// like (Apple's faces carry no colour bitmap table).
pub fn sbix_bytes() -> Vec<u8> {
    sfnt(vec![
        (b"cmap", cmap()),
        (b"glyf", Vec::new()), // no outlines: the bitmap is the glyph
        (b"head", head()),
        (b"hhea", hhea()),
        (b"hmtx", hmtx()),
        (b"loca", loca()),
        (b"maxp", maxp()),
        (b"name", name()),
        (b"sbix", sbix()),
    ])
}

/// Assemble a font file from its tables: the sfnt header, one directory entry
/// per table in tag order, then the table data padded to four-byte boundaries.
fn sfnt(mut tables: Vec<(&[u8; 4], Vec<u8>)>) -> Vec<u8> {
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


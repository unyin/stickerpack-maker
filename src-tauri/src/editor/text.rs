//! Text layers (SPEC §6, SPM-9): lay out and rasterise text in Rust, so
//! the view, "merge selected layers", Crop and the save flatten all draw the
//! same pixels whatever the webview's text renderer does (ADR-0005).
//!
//! Fonts are the system's (fontdb: the Windows Fonts folders, fontconfig on
//! Linux), looked up by family name. ab_glyph reads each glyph's outline and
//! metrics; tiny-skia fills the outlines, anti-aliased, as one path.
//!
//! Layout: lines split at '\n', left-aligned, kerned with the font's `kern`
//! table; no shaping (ligatures, complex scripts) and no font fallback. The
//! font size is the em size in px, as CSS `font-size`; lines are the font's
//! own line height apart (ascent + descent + line gap, CSS `line-height:
//! normal`). The layer's **box** is the layout box (the widest line by the
//! lines' height) grown to include any ink that overhangs it, rounded out to
//! whole pixels: the webview measures text layers by this box, so "longest
//! side exactly 512" holds for text as it does for images.

use std::sync::OnceLock;

use ab_glyph::{Font, FontRef, GlyphId, OutlineCurve};
use fontdb::{Database, Family, Query};
use serde::Deserialize;
use tiny_skia::{FillRule, Paint, Path, PathBuilder, Pixmap, Point, Transform};

use super::merge::{from_pixmap, transform_of, LayerTransform, PlacedImage, MAX_MERGE_SIDE};
use super::Rgba;
use crate::limits::{TEXT_MAX_FONT_SIZE, TEXT_MIN_FONT_SIZE};

/// A text layer's content and style; mirrors `TextStyle` in src/editor/model/document.ts.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSpec {
    pub text: String,
    pub font_family: String,
    /// Em size in px (CSS `font-size`).
    pub font_size: f32,
    /// `#rrggbb`.
    pub color: String,
}

/// Where the text sits in its box, in px at scale 1, for the webview's
/// text-editing overlay: the layout box's top-left within the box, and the
/// font's line metrics.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextMetrics {
    pub origin_x: f32,
    pub origin_y: f32,
    pub ascent: f32,
    /// Below the baseline, positive.
    pub descent: f32,
    pub line_height: f32,
}

/// A text layer drawn at scale 1: its box's pixels plus its metrics.
#[derive(Debug, Clone, PartialEq)]
pub struct TextRender {
    pub image: Rgba,
    pub metrics: TextMetrics,
}

impl TextRender {
    /// Binary IPC frame: five f32 LE (origin x, origin y, ascent, descent,
    /// line height), then `Rgba::to_frame`.
    pub fn to_frame(&self) -> Vec<u8> {
        let m = self.metrics;
        let mut frame = Vec::with_capacity(20 + 8 + self.image.pixels.len());
        for v in [m.origin_x, m.origin_y, m.ascent, m.descent, m.line_height] {
            frame.extend_from_slice(&v.to_le_bytes());
        }
        frame.extend_from_slice(&self.image.to_frame());
        frame
    }
}

/// The system's fonts, loaded once (the first call scans the font folders).
pub fn system_fonts() -> &'static Database {
    static FONTS: OnceLock<Database> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut db = Database::new();
        db.load_system_fonts();
        db
    })
}

/// Every font family in `fonts`, by its English (US) name when it has one,
/// sorted case-insensitively, each once.
pub fn families(fonts: &Database) -> Vec<String> {
    let mut names: Vec<String> =
        fonts.faces().filter_map(|face| face.families.first().map(|(name, _)| name.clone())).collect();
    names.sort_by_key(|n| (n.to_lowercase(), n.clone()));
    names.dedup();
    names
}

/// `#rrggbb` -> [r, g, b].
fn parse_color(color: &str) -> Result<[u8; 3], String> {
    let hex = color.strip_prefix('#').filter(|h| h.len() == 6 && h.bytes().all(|b| b.is_ascii_hexdigit()));
    let hex = hex.ok_or_else(|| format!("the text colour {color:?} is not a #rrggbb colour"))?;
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|e| e.to_string());
    Ok([channel(0)?, channel(2)?, channel(4)?])
}

fn check(spec: &TextSpec) -> Result<[u8; 3], String> {
    if spec.text.trim().is_empty() {
        return Err("a text layer needs some text".to_string());
    }
    let (min, max) = (TEXT_MIN_FONT_SIZE as f32, TEXT_MAX_FONT_SIZE as f32);
    if !(spec.font_size.is_finite() && spec.font_size >= min && spec.font_size <= max) {
        return Err(format!("the font size must be from {min} to {max} px"));
    }
    parse_color(&spec.color)
}

/// Text laid out in its box (whole pixels, top-left at 0, 0).
struct Laid {
    /// Every glyph's outline as one path; None when nothing is inked (spaces).
    path: Option<Path>,
    width: u32,
    height: u32,
    metrics: TextMetrics,
}

fn lay_out(font: &FontRef, spec: &TextSpec) -> Result<Laid, String> {
    let units = font.units_per_em().ok_or_else(|| "the font has no units per em".to_string())?;
    let s = spec.font_size / units;
    let ascent = font.ascent_unscaled() * s;
    let descent = -font.descent_unscaled() * s;
    let line_height = ascent + descent + font.line_gap_unscaled() * s;
    // Glyph outlines in layout coordinates (y down, first line's top at 0).
    let mut glyphs: Vec<(GlyphId, f32, f32)> = Vec::new();
    let mut widest = 0f32;
    let lines: Vec<&str> = spec.text.split('\n').collect();
    for (i, line) in lines.iter().enumerate() {
        let baseline = i as f32 * line_height + ascent;
        let mut pen = 0f32;
        let mut previous: Option<GlyphId> = None;
        for c in line.chars().filter(|&c| c != '\r') {
            let id = font.glyph_id(c);
            if let Some(p) = previous {
                pen += font.kern_unscaled(p, id) * s;
            }
            glyphs.push((id, pen, baseline));
            pen += font.h_advance_unscaled(id) * s;
            previous = Some(id);
        }
        widest = widest.max(pen);
    }
    let layout_height = (lines.len() - 1) as f32 * line_height + ascent + descent;
    let (mut left, mut top, mut right, mut bottom) = (0f32, 0f32, widest, layout_height);
    let mut outlines = Vec::new();
    for &(id, x, baseline) in &glyphs {
        let Some(outline) = font.outline(id) else { continue };
        let b = outline.bounds;
        left = left.min(x + b.min.x * s);
        right = right.max(x + b.max.x * s);
        top = top.min(baseline - b.max.y * s);
        bottom = bottom.max(baseline - b.min.y * s);
        outlines.push((outline, x, baseline));
    }
    let (left, top) = (left.floor(), top.floor());
    let width = ((right.ceil() - left) as u32).max(1);
    let height = ((bottom.ceil() - top) as u32).max(1);
    if width > MAX_MERGE_SIDE || height > MAX_MERGE_SIDE {
        return Err(format!(
            "the text would be {width}x{height} px, too large (at most {MAX_MERGE_SIDE} per side)"
        ));
    }
    // Box coordinates: the layout shifted so the box's top-left is (0, 0).
    let (ox, oy) = (-left, -top);
    let mut path = PathBuilder::new();
    for (outline, x, baseline) in outlines {
        let at = |p: ab_glyph::Point| (ox + x + p.x * s, oy + baseline - p.y * s);
        let mut current: Option<ab_glyph::Point> = None;
        for curve in &outline.curves {
            let start = match curve {
                OutlineCurve::Line(a, _) | OutlineCurve::Quad(a, _, _) | OutlineCurve::Cubic(a, _, _, _) => *a,
            };
            if current != Some(start) {
                if current.is_some() {
                    path.close();
                }
                let (px, py) = at(start);
                path.move_to(px, py);
            }
            let end = match *curve {
                OutlineCurve::Line(_, b) => {
                    let (bx, by) = at(b);
                    path.line_to(bx, by);
                    b
                }
                OutlineCurve::Quad(_, c, b) => {
                    let ((cx, cy), (bx, by)) = (at(c), at(b));
                    path.quad_to(cx, cy, bx, by);
                    b
                }
                OutlineCurve::Cubic(_, c1, c2, b) => {
                    let ((x1, y1), (x2, y2), (bx, by)) = (at(c1), at(c2), at(b));
                    path.cubic_to(x1, y1, x2, y2, bx, by);
                    b
                }
            };
            current = Some(end);
        }
        if current.is_some() {
            path.close();
        }
    }
    Ok(Laid {
        path: path.finish(),
        width,
        height,
        metrics: TextMetrics { origin_x: ox, origin_y: oy, ascent, descent, line_height },
    })
}

/// Look the font up by family (regular weight and style preferred) and run
/// `work` on the laid-out text.
fn with_layout<T>(
    fonts: &Database,
    spec: &TextSpec,
    work: impl FnOnce(Laid) -> Result<T, String>,
) -> Result<T, String> {
    let query = Query { families: &[Family::Name(&spec.font_family)], ..Query::default() };
    let missing = || format!("the font \"{}\" is not installed on this computer", spec.font_family);
    let id = fonts.query(&query).ok_or_else(missing)?;
    fonts
        .with_face_data(id, |data, index| {
            let font = FontRef::try_from_slice_and_index(data, index)
                .map_err(|_| format!("the font \"{}\" cannot be read", spec.font_family))?;
            work(lay_out(&font, spec)?)
        })
        .ok_or_else(missing)?
}

fn fill(canvas: &mut Pixmap, path: &Path, [r, g, b]: [u8; 3], transform: Transform) {
    let mut paint = Paint::default();
    paint.set_color_rgba8(r, g, b, 255);
    paint.anti_alias = true;
    canvas.fill_path(path, &paint, FillRule::Winding, transform, None);
}

/// Draw a text layer at scale 1 into its box: what the webview shows, and
/// the box it measures the layer by.
pub fn render(fonts: &Database, spec: &TextSpec) -> Result<TextRender, String> {
    let color = check(spec)?;
    with_layout(fonts, spec, |laid| {
        let mut canvas =
            Pixmap::new(laid.width, laid.height).ok_or_else(|| "cannot allocate the text".to_string())?;
        if let Some(path) = &laid.path {
            fill(&mut canvas, path, color, Transform::identity());
        }
        Ok(TextRender { image: from_pixmap(&canvas), metrics: laid.metrics })
    })
}

/// Draw a text layer placed by its transform, straight from the outlines
/// (sharp at any scale), into the whole pixels its box covers in the
/// document: merge and Crop composite this exactly like a raster layer.
pub fn rasterise_placed(fonts: &Database, spec: &TextSpec, t: &LayerTransform) -> Result<PlacedImage, String> {
    let color = check(spec)?;
    let transform = transform_of(t)?;
    with_layout(fonts, spec, |laid| {
        let (w, h) = (laid.width as f32, laid.height as f32);
        let mut corners =
            [Point::from_xy(0.0, 0.0), Point::from_xy(w, 0.0), Point::from_xy(0.0, h), Point::from_xy(w, h)];
        transform.map_points(&mut corners);
        let snap = |v: f32| if (v - v.round()).abs() < 1e-3 { v.round() } else { v };
        let left = snap(corners.iter().map(|c| c.x).fold(f32::MAX, f32::min)).floor();
        let top = snap(corners.iter().map(|c| c.y).fold(f32::MAX, f32::min)).floor();
        let right = snap(corners.iter().map(|c| c.x).fold(f32::MIN, f32::max)).ceil();
        let bottom = snap(corners.iter().map(|c| c.y).fold(f32::MIN, f32::max)).ceil();
        let (width, height) = ((right - left) as u32, (bottom - top) as u32);
        if width > MAX_MERGE_SIDE || height > MAX_MERGE_SIDE {
            return Err(format!(
                "the text would be drawn {width}x{height} px, too large (at most {MAX_MERGE_SIDE} per side)"
            ));
        }
        let mut canvas = Pixmap::new(width.max(1), height.max(1))
            .ok_or_else(|| "cannot allocate the text".to_string())?;
        if let Some(path) = &laid.path {
            fill(&mut canvas, path, color, transform.post_translate(-left, -top));
        }
        Ok(PlacedImage { x: left as i32, y: top as i32, image: from_pixmap(&canvas) })
    })
}

#[cfg(test)]
mod tests {
    use super::super::test_font::{self, FAMILY};
    use super::*;

    fn spec(text: &str, size: f32) -> TextSpec {
        TextSpec { text: text.into(), font_family: FAMILY.into(), font_size: size, color: "#ff0000".into() }
    }

    fn px(image: &Rgba, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width + x) * 4) as usize;
        image.pixels[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn the_test_font_is_found_by_family() {
        assert_eq!(families(&test_font::database()), vec![FAMILY.to_string()]);
    }

    #[test]
    fn one_glyph_fills_exactly_its_outline_in_the_chosen_colour() {
        // 100 px em: 'A' is the box x 10..50, y 10..80 (ascent 80, baseline
        // at 80); the layout box is 60 (advance) by 100 (ascent + descent).
        let out = render(&test_font::database(), &spec("A", 100.0)).unwrap();
        assert_eq!((out.image.width, out.image.height), (60, 100));
        assert_eq!(out.metrics, TextMetrics { origin_x: 0.0, origin_y: 0.0, ascent: 80.0, descent: 20.0, line_height: 110.0 });
        assert_eq!(px(&out.image, 10, 10), [255, 0, 0, 255]);
        assert_eq!(px(&out.image, 49, 79), [255, 0, 0, 255]);
        assert_eq!(px(&out.image, 9, 40)[3], 0);
        assert_eq!(px(&out.image, 50, 40)[3], 0);
        assert_eq!(px(&out.image, 30, 9)[3], 0);
        assert_eq!(px(&out.image, 30, 80)[3], 0);
    }

    #[test]
    fn lines_stack_by_the_line_height_and_the_widest_sets_the_width() {
        // "AA" is 120 wide; two lines are 110 + 100 tall.
        let out = render(&test_font::database(), &spec("A\nAA", 100.0)).unwrap();
        assert_eq!((out.image.width, out.image.height), (120, 210));
        // Second line's second 'A': x 70..110, y 120..190.
        assert_eq!(px(&out.image, 70, 120)[3], 255);
        assert_eq!(px(&out.image, 70, 40)[3], 0, "the first line has one glyph");
    }

    #[test]
    fn ink_beyond_the_layout_box_grows_the_box() {
        // 'j' inks 10 px left of the pen: the box starts there, and the
        // layout box (origin) sits 10 px in.
        let out = render(&test_font::database(), &spec("j", 100.0)).unwrap();
        assert_eq!(out.metrics.origin_x, 10.0);
        assert_eq!((out.image.width, out.image.height), (40, 100));
        assert_eq!(px(&out.image, 0, 50)[3], 255);
    }

    #[test]
    fn spaces_count_toward_the_box_but_ink_nothing() {
        let out = render(&test_font::database(), &spec("A ", 100.0)).unwrap();
        assert_eq!(out.image.width, 90);
        assert!(out.image.pixels.chunks(4).skip(60).step_by(90).all(|p| p[3] == 0));
    }

    #[test]
    fn placed_text_covers_the_transformed_box_and_stays_sharp() {
        let fonts = test_font::database();
        let s = spec("A", 100.0);
        // Scale 2 at (5, 7): the box is 120x200 there, the glyph x 25..105.
        let t = LayerTransform { x: 5.0, y: 7.0, scale_x: 2.0, scale_y: 2.0, rotation: 0.0 };
        let placed = rasterise_placed(&fonts, &s, &t).unwrap();
        assert_eq!((placed.x, placed.y, placed.image.width, placed.image.height), (5, 7, 120, 200));
        // Edges are exact (vector), not resampled from the scale-1 bitmap.
        assert_eq!(px(&placed.image, 20, 100)[3], 255);
        assert_eq!(px(&placed.image, 19, 100)[3], 0);
        // Rotated 90 degrees about its top-left: it swings left of x.
        let r = LayerTransform { x: 300.0, y: 0.0, scale_x: 1.0, scale_y: 1.0, rotation: 90.0 };
        let placed = rasterise_placed(&fonts, &s, &r).unwrap();
        assert_eq!((placed.x, placed.y, placed.image.width, placed.image.height), (200, 0, 100, 60));
    }

    #[test]
    fn bad_specs_are_refused_with_reasons() {
        let fonts = test_font::database();
        assert!(render(&fonts, &spec("  \n ", 10.0)).unwrap_err().contains("needs some text"));
        assert!(render(&fonts, &spec("A", 0.5)).unwrap_err().contains("font size"));
        assert!(render(&fonts, &spec("A", f32::NAN)).is_err());
        let mut bad = spec("A", 10.0);
        bad.color = "red".into();
        assert!(render(&fonts, &bad).unwrap_err().contains("#rrggbb"));
        bad = spec("A", 10.0);
        bad.font_family = "Nope".into();
        assert!(render(&fonts, &bad).unwrap_err().contains("not installed"));
        let long = spec(&"A".repeat(200), TEXT_MAX_FONT_SIZE as f32);
        assert!(render(&fonts, &long).unwrap_err().contains("too large"));
    }

    /// Real system fonts (run with `cargo test -- --ignored`): lists the
    /// installed families and draws a line in the first of a few common ones.
    /// On Windows this exercises Arial or Segoe UI from C:\Windows\Fonts.
    #[test]
    #[ignore = "depends on the machine's installed fonts"]
    fn system_fonts_list_and_render() {
        let fonts = system_fonts();
        let names = families(fonts);
        assert!(!names.is_empty(), "no system fonts found");
        let family = ["Arial", "Segoe UI", "DejaVu Sans", "Liberation Sans", "Noto Sans", "Ubuntu"]
            .into_iter()
            .find(|f| names.iter().any(|n| n == f))
            .unwrap_or(&names[0]);
        let s = TextSpec { font_family: family.to_string(), ..spec("Hello, sticker! gjpqy", 48.0) };
        let out = render(fonts, &s).unwrap();
        assert!(out.image.width > 200 && out.image.height >= 48, "{family}: {}x{}", out.image.width, out.image.height);
        assert!(out.image.pixels.chunks(4).any(|p| p[3] == 255), "{family}: no ink");
        if let Ok(dir) = std::env::var("SPM_TEXT_DUMP") {
            let path = std::path::Path::new(&dir).join("system-text.png");
            image::save_buffer(&path, &out.image.pixels, out.image.width, out.image.height, image::ExtendedColorType::Rgba8)
                .unwrap();
        }
    }

    #[test]
    fn colours_parse_from_hex() {
        assert_eq!(parse_color("#00ff7F").unwrap(), [0, 255, 127]);
        assert!(parse_color("#fff").is_err());
        assert!(parse_color("00ff00").is_err());
    }

    #[test]
    fn the_render_frame_prefixes_the_metrics() {
        let out = render(&test_font::database(), &spec("A", 10.0)).unwrap();
        let frame = out.to_frame();
        assert_eq!(f32::from_le_bytes(frame[8..12].try_into().unwrap()), 8.0);
        assert_eq!(&frame[20..28], &[6, 0, 0, 0, 10, 0, 0, 0]);
    }

    #[test]
    fn spec_json_matches_the_typescript_field_names() {
        let s: TextSpec =
            serde_json::from_str(r##"{"text":"hi","fontFamily":"Arial","fontSize":24,"color":"#000000"}"##).unwrap();
        assert_eq!(s.font_family, "Arial");
        assert_eq!(s.font_size, 24.0);
    }
}

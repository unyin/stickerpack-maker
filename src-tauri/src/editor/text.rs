//! Text layers (SPEC §6, SPM-9/SPM-20): lay out and rasterise text in Rust,
//! so the view, "merge selected layers", Crop and the save flatten all draw
//! the same pixels whatever the webview's text renderer does (ADR-0005).
//!
//! Fonts are the system's (fontdb: the Windows Fonts folders, fontconfig on
//! Linux), looked up by family name. ab_glyph reads each glyph's outline and
//! metrics; tiny-skia fills the outlines, anti-aliased, as one path.
//!
//! Since SPM-20 a character the chosen font lacks is no longer lost: it
//! falls back per character — a fixed preference list first, then any
//! installed face whose cmap covers it — and an emoji-presentation
//! character is drawn IN COLOUR from the style's emoji font chain
//! (super::emoji), never as a monochrome outline (SPEC §5). Layout stays
//! no-shaping (SPM-9's line): lines split at '\n', left-aligned, kerned
//! with the chosen font's `kern` table; what the emoji font ligates with
//! plain GSUB ligatures (ZWJ sequences, flags, keycaps), we ligate, and a
//! joiner nothing consumes draws nothing. The font size is the em size in
//! px, as CSS `font-size`; lines are the chosen font's own line height
//! apart (ascent + descent + line gap, CSS `line-height: normal`), and
//! fallback and emoji glyphs scale to the same em size. The layer's **box**
//! is the layout box (the widest line by the lines' height) grown to
//! include any ink that overhangs it — fallback and emoji ink included —
//! rounded out to whole pixels: the webview measures text layers by this
//! box, so "longest side exactly 512" holds for text as it does for
//! images.

use std::collections::HashMap;
use std::sync::OnceLock;

use ab_glyph::{Font, FontRef, GlyphId, OutlineCurve};
use fontdb::{Database, Family, Query};
use serde::Deserialize;
use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Transform};
use ttf_parser::{GlyphId as EmojiGlyphId, RgbaColor};

use super::emoji::{
    colour_glyph_bounds, continues_emoji_run, is_vs16, is_zwj, starts_emoji_run, DrawPainter,
    EmojiFonts,
};
use super::placement::{check_extent, from_pixmap, transform_of, Bounds, LayerTransform, PlacedImage};
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
pub(super) fn parse_color(color: &str) -> Result<[u8; 3], String> {
    let hex = color.strip_prefix('#').filter(|h| h.len() == 6 && h.bytes().all(|b| b.is_ascii_hexdigit()));
    let hex = hex.ok_or_else(|| format!("the colour {color:?} is not a #rrggbb colour"))?;
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
    /// Every monochrome glyph's outline as one path; None when nothing is
    /// inked (spaces alone, or all-emoji text).
    path: Option<tiny_skia::Path>,
    /// Colour glyphs from the emoji chain, at their pen positions.
    colour: Vec<ColourGlyph>,
    width: u32,
    height: u32,
    metrics: TextMetrics,
}

/// A colour glyph to paint after the monochrome path: which emoji chain
/// source, which glyph, at what pen x (layout coordinates) and baseline,
/// with its font-unit scale.
#[derive(Clone, Copy)]
struct ColourGlyph {
    source: usize,
    id: EmojiGlyphId,
    scale: f32,
    x: f32,
    baseline: f32,
}

/// A resolvable monochrome glyph: which face draws it, its glyph id, its
/// advance in px and its font-unit scale (fallback glyphs scale to the
/// same em size as the chosen font, SPM-20).
#[derive(Clone, Copy)]
struct MonoGlyph {
    face: fontdb::ID,
    id: GlyphId,
    advance: f32,
    scale: f32,
}

/// Fixed-preference fallback families (SPM-20), tried after the chosen
/// font and before the any-covering-face scan: faces every Windows install
/// has, plus the Linux test machines' equivalents.
const FALLBACK_FAMILIES: [&str; 7] =
    ["Segoe UI", "Arial", "Microsoft YaHei", "Yu Gothic", "DejaVu Sans", "Liberation Sans", "Noto Sans"];

/// The chosen font plus the fallback context a layout needs.
struct Layout<'a> {
    fonts: &'a Database,
    /// The chosen font's fontdb id: kerning applies only between its glyphs.
    chosen: fontdb::ID,
    /// The text's font size in px — the em size every face scales to.
    size: f32,
    /// px per chosen-font font unit at `size`.
    s: f32,
    /// Per-character fallback glyphs resolved this layout: the chosen
    /// font's own glyph when it covers the character, else the first
    /// covering face's, else the chosen font's tofu (notdef) — the
    /// character is never silently lost.
    resolved: HashMap<char, MonoGlyph>,
}

impl Layout<'_> {
    fn chosen_glyph(font: &FontRef, face: fontdb::ID, c: char, size: f32) -> MonoGlyph {
        let id = font.glyph_id(c);
        let scale = size / font.units_per_em().unwrap_or(1000.0);
        MonoGlyph { face, id, advance: font.h_advance_unscaled(id) * scale, scale }
    }

    /// A character's monochrome glyph from the chosen font, the fallback
    /// chain, or the chosen font's tofu — cached per character.
    fn glyph_for(&mut self, font: &FontRef, c: char) -> MonoGlyph {
        if let Some(glyph) = self.resolved.get(&c) {
            return *glyph;
        }
        let glyph = if font.glyph_id(c) != GlyphId(0) {
            Self::chosen_glyph(font, self.chosen, c, self.size)
        } else {
            self.fallback(c).unwrap_or_else(|| Self::chosen_glyph(font, self.chosen, c, self.size))
        };
        self.resolved.insert(c, glyph);
        glyph
    }

    /// The first face outside the chosen font covering `c`: the fixed
    /// families, then any installed face whose cmap has the character.
    fn fallback(&self, c: char) -> Option<MonoGlyph> {
        for family in FALLBACK_FAMILIES {
            let query = Query { families: &[Family::Name(family)], ..Query::default() };
            if let Some(id) = self.fonts.query(&query) {
                if let Some(glyph) = self.face_glyph(id, c) {
                    return Some(glyph);
                }
            }
        }
        for face in self.fonts.faces() {
            if let Some(glyph) = self.face_glyph(face.id, c) {
                return Some(glyph);
            }
        }
        None
    }

    /// A face's glyph for `c`, or `None` when it does not cover it.
    fn face_glyph(&self, id: fontdb::ID, c: char) -> Option<MonoGlyph> {
        self.fonts
            .with_face_data(id, |data, index| {
                let font = FontRef::try_from_slice_and_index(data, index).ok()?;
                let glyph = font.glyph_id(c);
                if glyph == GlyphId(0) {
                    return None;
                }
                let scale = self.size / font.units_per_em().unwrap_or(1000.0);
                Some(MonoGlyph { face: id, id: glyph, advance: font.h_advance_unscaled(glyph) * scale, scale })
            })
            .flatten()
    }
}

/// A monochrome glyph placed on a line: which face draws it, its glyph
/// id, its pen x and baseline, and that face's px-per-font-unit scale.
#[derive(Clone, Copy)]
struct PlacedGlyph {
    face: fontdb::ID,
    id: GlyphId,
    x: f32,
    baseline: f32,
    scale: f32,
}

/// Text laid out in pass 1: positioned glyphs, emoji runs already resolved
/// into colour glyphs with their advances.
struct Items {
    mono: Vec<PlacedGlyph>,
    colour: Vec<ColourGlyph>,
    widest: f32,
}

/// Collect an emoji run's continuation (joiners, selectors, tones, more
/// starters) after its first characters. A character right after a ZWJ
/// joins the run whatever its own presentation — that is what a ZWJ means —
/// and the profession emoji end in text-presentation symbols (⚕, ✈, ⚧):
/// cutting the run there would draw man + tofu where the overlay ligates.
fn extend_run(run: &mut Vec<char>, chars: &mut std::iter::Peekable<impl Iterator<Item = char>>) {
    while let Some(&next) = chars.peek() {
        if continues_emoji_run(next) || is_zwj(*run.last().unwrap()) {
            run.push(next);
            chars.next();
        } else {
            break;
        }
    }
}

/// Lay the spec out (SPM-20): every character positioned — the chosen
/// font, a fallback face, or a colour glyph from the emoji chain — then
/// the box all their ink covers.
fn lay_out(
    fonts: &Database,
    emoji: &EmojiFonts,
    spec: &TextSpec,
    chosen: &FontRef,
    chosen_id: fontdb::ID,
) -> Result<Laid, String> {
    let units = chosen.units_per_em().ok_or_else(|| "the font has no units per em".to_string())?;
    let s = spec.font_size / units;
    let ascent = chosen.ascent_unscaled() * s;
    let descent = -chosen.descent_unscaled() * s;
    let line_height = ascent + descent + chosen.line_gap_unscaled() * s;
    let mut layout =
        Layout { fonts, chosen: chosen_id, size: spec.font_size, s, resolved: HashMap::new() };
    let mut items = Items { mono: Vec::new(), colour: Vec::new(), widest: 0.0 };
    let lines: Vec<&str> = spec.text.split('\n').collect();
    for (i, line) in lines.iter().enumerate() {
        let baseline = i as f32 * line_height + ascent;
        let mut pen = 0f32;
        // Kerning pairs only exist inside the chosen font.
        let mut previous: Option<GlyphId> = None;
        let mut chars = line.chars().filter(|&c| c != '\r').peekable();
        while let Some(c) = chars.next() {
            // An emoji run: a starter, or a character a following VS16
            // flips to emoji presentation, extended greedily.
            let run: Vec<char> = if starts_emoji_run(c) {
                let mut run = vec![c];
                extend_run(&mut run, &mut chars);
                run
            } else if chars.peek() == Some(&'\u{FE0F}') {
                let mut run = vec![c, '\u{FE0F}'];
                chars.next();
                extend_run(&mut run, &mut chars);
                run
            } else if is_vs16(c) || is_zwj(c) {
                // A stray selector or joiner: default-ignorable.
                continue;
            } else {
                Vec::new()
            };
            if !run.is_empty() {
                if let Some(glyphs) = emoji.resolve_run(fonts, &run, spec.font_size) {
                    for g in glyphs {
                        items.colour.push(ColourGlyph {
                            source: g.source,
                            id: g.id,
                            scale: g.scale,
                            x: pen,
                            baseline,
                        });
                        pen += g.advance;
                    }
                    previous = None; // no kern pairs across an emoji
                    items.widest = items.widest.max(pen);
                    continue;
                }
                // No emoji font colour-covers the run: its content
                // characters fall back to text like any other.
                for rc in run {
                    if is_zwj(rc) || is_vs16(rc) {
                        continue;
                    }
                    pen = place_mono(&mut items, &mut layout, chosen, rc, pen, baseline, &mut previous);
                }
                items.widest = items.widest.max(pen);
                continue;
            }
            pen = place_mono(&mut items, &mut layout, chosen, c, pen, baseline, &mut previous);
            items.widest = items.widest.max(pen);
        }
    }
    let layout_height = (lines.len() - 1) as f32 * line_height + ascent + descent;
    box_and_path(fonts, emoji, items, layout_height, ascent, descent, line_height)
}

/// Position one character's monochrome glyph, kerned against the previous
/// chosen-font glyph, and return the advanced pen.
fn place_mono(
    items: &mut Items,
    layout: &mut Layout,
    chosen: &FontRef,
    c: char,
    pen: f32,
    baseline: f32,
    previous: &mut Option<GlyphId>,
) -> f32 {
    let glyph = layout.glyph_for(chosen, c);
    let mut pen = pen;
    if glyph.face == layout.chosen {
        if let Some(p) = *previous {
            pen += chosen.kern_unscaled(p, glyph.id) * layout.s;
        }
        *previous = Some(glyph.id);
    } else {
        *previous = None;
    }
    items.mono.push(PlacedGlyph { face: glyph.face, id: glyph.id, x: pen, baseline, scale: glyph.scale });
    pen + glyph.advance
}

/// The box every glyph inks and the one path all monochrome outlines form.
fn box_and_path(
    fonts: &Database,
    emoji: &EmojiFonts,
    items: Items,
    layout_height: f32,
    ascent: f32,
    descent: f32,
    line_height: f32,
) -> Result<Laid, String> {
    let Items { mono, colour, widest } = items;
    // Ink bounds: the monochrome outlines and the colour glyphs' ink.
    let (mut left, mut top, mut right, mut bottom) = (0f32, 0f32, widest, layout_height);
    let mut faces: HashMap<fontdb::ID, Vec<PlacedGlyph>> = HashMap::new();
    for g in &mono {
        faces.entry(g.face).or_default().push(*g);
        fonts
            .with_face_data(g.face, |data, index| {
                let font = FontRef::try_from_slice_and_index(data, index).ok()?;
                let outline = font.outline(g.id)?;
                let b = outline.bounds;
                left = left.min(g.x + b.min.x * g.scale);
                right = right.max(g.x + b.max.x * g.scale);
                top = top.min(g.baseline - b.max.y * g.scale);
                bottom = bottom.max(g.baseline - b.min.y * g.scale);
                Some(())
            })
            .flatten();
    }
    for glyph in &colour {
        let ink = emoji.with_source(fonts, glyph.source, |face| {
            colour_glyph_bounds(face, glyph.id).map(|(x0, y0, x1, y1)| {
                (
                    glyph.x + x0 * glyph.scale,
                    glyph.baseline - y1 * glyph.scale,
                    glyph.x + x1 * glyph.scale,
                    glyph.baseline - y0 * glyph.scale,
                )
            })
        });
        // with_source already returns Option<T>; the work returns Option.
        if let Some((x0, y0, x1, y1)) = ink.flatten() {
            left = left.min(x0);
            right = right.max(x1);
            top = top.min(y0);
            bottom = bottom.max(y1);
        }
    }
    let (left, top) = (left.floor(), top.floor());
    let width = ((right.ceil() - left) as u32).max(1);
    let height = ((bottom.ceil() - top) as u32).max(1);
    check_extent(width, height, "text")?;
    // Box coordinates: the layout shifted so the box's top-left is (0, 0).
    let (ox, oy) = (-left, -top);
    let mut path = PathBuilder::new();
    for (face, glyphs) in &faces {
        fonts.with_face_data(*face, |data, index| {
            let font = FontRef::try_from_slice_and_index(data, index).ok()?;
            for g in glyphs {
                append_outline(&mut path, &font, g.id, g.scale, ox + g.x, oy + g.baseline);
            }
            Some(())
        });
    }
    Ok(Laid {
        path: path.finish(),
        colour,
        width,
        height,
        metrics: TextMetrics { origin_x: ox, origin_y: oy, ascent, descent, line_height },
    })
}

/// Append a glyph's outline to the path, in box coordinates (y down): the
/// outline scaled by `scale` (px per font unit), its pen at (`x0`, `y0`)
/// — the box-shifted pen position.
fn append_outline(path: &mut PathBuilder, font: &FontRef, id: GlyphId, scale: f32, x0: f32, y0: f32) {
    let Some(outline) = font.outline(id) else { return };
    let at = |p: ab_glyph::Point| (x0 + p.x * scale, y0 - p.y * scale);
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

/// Look the font up by family (regular weight and style preferred) and run
/// `work` on the laid-out text.
fn with_layout<T>(
    fonts: &Database,
    emoji: &EmojiFonts,
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
            work(lay_out(fonts, emoji, spec, &font, id)?)
        })
        .ok_or_else(missing)?
}

fn fill(canvas: &mut Pixmap, path: &tiny_skia::Path, [r, g, b]: [u8; 3], transform: Transform) {
    let mut paint = Paint::default();
    paint.set_color_rgba8(r, g, b, 255);
    paint.anti_alias = true;
    canvas.fill_path(path, &paint, FillRule::Winding, transform, None);
}

/// Paint a laid-out text's colour glyphs (after its monochrome path).
/// `transform` maps the box (origin at `metrics`' origin) into the target.
fn paint_colour(
    canvas: &mut Pixmap,
    fonts: &Database,
    emoji: &EmojiFonts,
    laid: &Laid,
    [r, g, b]: [u8; 3],
    transform: Transform,
) {
    let foreground = RgbaColor::new(r, g, b, 255);
    let (ox, oy) = (laid.metrics.origin_x, laid.metrics.origin_y);
    for glyph in &laid.colour {
        emoji.with_source(fonts, glyph.source, |face| {
            let place = Transform::from_scale(glyph.scale, -glyph.scale)
                .post_translate(ox + glyph.x, oy + glyph.baseline);
            let mut painter = DrawPainter::new(face, canvas, transform.pre_concat(place));
            face.paint_color_glyph(glyph.id, 0, foreground, &mut painter);
        });
    }
}

/// Draw a text layer at scale 1 into its box: what the webview shows, and
/// the box it measures the layer by.
pub fn render(fonts: &Database, emoji: &EmojiFonts, spec: &TextSpec) -> Result<TextRender, String> {
    let color = check(spec)?;
    with_layout(fonts, emoji, spec, |laid| {
        let mut canvas =
            Pixmap::new(laid.width, laid.height).ok_or_else(|| "cannot allocate the text".to_string())?;
        if let Some(path) = &laid.path {
            fill(&mut canvas, path, color, Transform::identity());
        }
        paint_colour(&mut canvas, fonts, emoji, &laid, color, Transform::identity());
        Ok(TextRender { image: from_pixmap(&canvas), metrics: laid.metrics })
    })
}

/// Draw a text layer placed by its transform, straight from the outlines
/// (sharp at any scale), into the whole pixels its box covers in the
/// document: merge composites this exactly like a raster layer.
pub fn rasterise_placed(
    fonts: &Database,
    emoji: &EmojiFonts,
    spec: &TextSpec,
    t: &LayerTransform,
) -> Result<PlacedImage, String> {
    let color = check(spec)?;
    let transform = transform_of(t)?;
    with_layout(fonts, emoji, spec, |laid| {
        let (left, top, width, height) = Bounds::of(&transform, laid.width, laid.height).whole_pixels();
        check_extent(width, height, "text")?;
        let image = draw_window(
            fonts,
            emoji,
            &laid,
            color,
            transform,
            TextWindow { x: left as i32, y: top as i32, width, height },
        )?;
        Ok(PlacedImage { x: left as i32, y: top as i32, image })
    })
}

/// The window `rasterise_window` draws into: top-left and size in whole
/// document pixels — Crop's clip-sized window (placement.rs
/// `render_window`) or the save's whole canvas. The caller has already
/// checked it (placement.rs `check_window`).
#[derive(Clone, Copy)]
pub struct TextWindow {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Draw a text layer placed by its transform into just the document window
/// `window`, so a crossing text layer costs only its clip's memory,
/// whatever size it is drawn at. Pixels match `rasterise_placed`'s up to
/// the whole-pixel shift of the window.
pub fn rasterise_window(
    fonts: &Database,
    emoji: &EmojiFonts,
    spec: &TextSpec,
    t: &LayerTransform,
    window: TextWindow,
) -> Result<Rgba, String> {
    let color = check(spec)?;
    let transform = transform_of(t)?;
    with_layout(fonts, emoji, spec, |laid| {
        draw_window(fonts, emoji, &laid, color, transform, window)
    })
}

/// Fill a layout's outlines and paint its colour glyphs, placed by
/// `transform`, into the pixmap of `window` (whole document pixels).
fn draw_window(
    fonts: &Database,
    emoji: &EmojiFonts,
    laid: &Laid,
    color: [u8; 3],
    transform: Transform,
    window: TextWindow,
) -> Result<Rgba, String> {
    let mut canvas =
        Pixmap::new(window.width.max(1), window.height.max(1)).ok_or_else(|| "cannot allocate the text".to_string())?;
    let transform = transform.post_translate(-window.x as f32, -window.y as f32);
    if let Some(path) = &laid.path {
        fill(&mut canvas, path, color, transform);
    }
    paint_colour(&mut canvas, fonts, emoji, laid, color, transform);
    Ok(from_pixmap(&canvas))
}

#[cfg(test)]
mod tests {
    use super::super::emoji::{bundled_bytes, EmojiSource};
    use super::super::emoji_test_font;
    use super::super::fallback_test_font;
    use super::super::test_font::{self, FAMILY};
    use super::*;

    fn spec(text: &str, size: f32) -> TextSpec {
        TextSpec { text: text.into(), font_family: FAMILY.into(), font_size: size, color: "#ff0000".into() }
    }

    /// The test fonts' database: the chosen Test Sans plus its fallback
    /// family (and no system fonts).
    fn fonts() -> Database {
        let mut db = test_font::database();
        db.load_font_data(fallback_test_font::bytes());
        db
    }

    /// An emoji chain of the synthetic colour font alone: routing and
    /// colour painting against deterministic fixtures. The real Noto in a
    /// multi-source chain is exercised by emoji.rs's chain-walk test.
    fn emoji_chain() -> EmojiFonts {
        EmojiFonts::new(vec![EmojiSource::Bytes(std::sync::Arc::new(emoji_test_font::bytes()))])
    }

    fn px(image: &Rgba, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width + x) * 4) as usize;
        image.pixels[i..i + 4].try_into().unwrap()
    }

    /// How many distinct non-transparent colours the image holds.
    fn colours(image: &Rgba) -> std::collections::HashSet<[u8; 4]> {
        image
            .pixels
            .chunks(4)
            .filter(|p| p[3] > 0)
            .map(|p| p.try_into().unwrap())
            .collect()
    }

    #[test]
    fn the_test_font_is_found_by_family() {
        let db = test_font::database();
        assert!(families(&db).contains(&FAMILY.to_string()));
    }

    #[test]
    fn one_glyph_fills_exactly_its_outline_in_the_chosen_colour() {
        // 100 px em: 'A' is the box x 10..50, y 10..80 (ascent 80, baseline
        // at 80); the layout box is 60 (advance) by 100 (ascent + descent).
        let out = render(&fonts(), &EmojiFonts::empty(), &spec("A", 100.0)).unwrap();
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
        let out = render(&fonts(), &EmojiFonts::empty(), &spec("A\nAA", 100.0)).unwrap();
        assert_eq!((out.image.width, out.image.height), (120, 210));
        // Second line's second 'A': x 70..110, y 120..190.
        assert_eq!(px(&out.image, 70, 120)[3], 255);
        assert_eq!(px(&out.image, 70, 40)[3], 0, "the first line has one glyph");
    }

    #[test]
    fn ink_beyond_the_layout_box_grows_the_box() {
        // 'j' inks 10 px left of the pen: the box starts there, and the
        // layout box (origin) sits 10 px in.
        let out = render(&fonts(), &EmojiFonts::empty(), &spec("j", 100.0)).unwrap();
        assert_eq!(out.metrics.origin_x, 10.0);
        assert_eq!((out.image.width, out.image.height), (40, 100));
        assert_eq!(px(&out.image, 0, 50)[3], 255);
    }

    #[test]
    fn spaces_count_toward_the_box_but_ink_nothing() {
        let out = render(&fonts(), &EmojiFonts::empty(), &spec("A ", 100.0)).unwrap();
        assert_eq!(out.image.width, 90);
        assert!(out.image.pixels.chunks(4).skip(60).step_by(90).all(|p| p[3] == 0));
    }

    #[test]
    fn placed_text_covers_the_transformed_box_and_stays_sharp() {
        let db = fonts();
        let s = spec("A", 100.0);
        // Scale 2 at (5, 7): the box is 120x200 there, the glyph x 25..105.
        let t = LayerTransform { x: 5.0, y: 7.0, scale_x: 2.0, scale_y: 2.0, rotation: 0.0 };
        let placed = rasterise_placed(&db, &EmojiFonts::empty(), &s, &t).unwrap();
        assert_eq!((placed.x, placed.y, placed.image.width, placed.image.height), (5, 7, 120, 200));
        // Edges are exact (vector), not resampled from the scale-1 bitmap.
        assert_eq!(px(&placed.image, 20, 100)[3], 255);
        assert_eq!(px(&placed.image, 19, 100)[3], 0);
        // Rotated 90 degrees about its top-left: it swings left of x.
        let r = LayerTransform { x: 300.0, y: 0.0, scale_x: 1.0, scale_y: 1.0, rotation: 90.0 };
        let placed = rasterise_placed(&db, &EmojiFonts::empty(), &s, &r).unwrap();
        assert_eq!((placed.x, placed.y, placed.image.width, placed.image.height), (200, 0, 100, 60));
    }

    #[test]
    fn bad_specs_are_refused_with_reasons() {
        let db = fonts();
        let empty = EmojiFonts::empty();
        assert!(render(&db, &empty, &spec("  \n ", 10.0)).unwrap_err().contains("needs some text"));
        assert!(render(&db, &empty, &spec("A", 0.5)).unwrap_err().contains("font size"));
        assert!(render(&db, &empty, &spec("A", f32::NAN)).is_err());
        let mut bad = spec("A", 10.0);
        bad.color = "red".into();
        assert!(render(&db, &empty, &bad).unwrap_err().contains("#rrggbb"));
        bad = spec("A", 10.0);
        bad.font_family = "Nope".into();
        assert!(render(&db, &empty, &bad).unwrap_err().contains("not installed"));
        let long = spec(&"A".repeat(200), TEXT_MAX_FONT_SIZE as f32);
        assert!(render(&db, &empty, &long).unwrap_err().contains("too large"));
    }

    // ---- SPM-20: fallback, routing, colour ----

    #[test]
    fn a_missing_character_falls_back_to_another_face() {
        // Test Sans lacks 'é'; Fallback Sans (2048 units per em, so a
        // different scale) covers it with a box x 100..1000, advance 1000.
        let out = render(&fonts(), &EmojiFonts::empty(), &spec("Aé", 100.0)).unwrap();
        // 'A' 60 px + é (advance 1000/2048 of 100 px ≈ 48.8) → 109 px wide.
        assert_eq!(out.image.width, 109);
        // é's ink sits after A's: x 60 + (100/2048)*100 ≈ 64.9 .. ≈ 108.8.
        assert_eq!(px(&out.image, 65, 40)[3], 255, "é inks after A");
        assert_eq!(px(&out.image, 51, 40)[3], 0, "the gap between A and é is empty");
        assert!(px(&out.image, 108, 40)[3] > 0, "é's anti-aliased edge inks the last column");
    }

    #[test]
    fn a_character_no_face_covers_draws_tofu_not_nothing() {
        // '中' is in no test face: the chosen font's notdef advances and
        // nothing is lost silently — here notdef has no outline, so the
        // character advances without ink, as before SPM-20.
        let out = render(&fonts(), &EmojiFonts::empty(), &spec("A中", 100.0)).unwrap();
        assert_eq!(out.image.width, 110, "notdef advances 50 px");
    }

    #[test]
    fn an_emoji_renders_in_more_than_one_colour() {
        // 😀 maps to a two-layer COLRv0 glyph in the synthetic emoji font:
        // background green with a red face over it.
        let out = render(&fonts(), &emoji_chain(), &spec("😀", 100.0)).unwrap();
        let seen = colours(&out.image);
        assert!(seen.contains(&[0, 255, 0, 255]), "the background layer is green: {seen:?}");
        assert!(seen.contains(&[255, 0, 0, 255]), "the face layer is red: {seen:?}");
        assert!(out.image.width > 0 && out.image.height > 0);
    }

    #[test]
    fn the_box_includes_emoji_ink_beyond_the_advance() {
        // The synthetic emoji inks outside its advance horizontally and
        // past the chosen font's line box on both axes (above the ascent,
        // below the descent): the box grows to the ink, matching what is
        // drawn.
        let out = render(&fonts(), &emoji_chain(), &spec("😀", 100.0)).unwrap();
        assert_eq!((out.image.width, out.image.height), (120, 120), "the box grows on all four sides");
        let ink = |x: u32, y: u32| px(&out.image, x, y)[3] > 0;
        assert!(ink(0, 0) && ink(out.image.width - 1, out.image.height - 1), "ink reaches the box edges");
    }

    #[test]
    fn plain_digits_never_route_to_the_emoji_font() {
        // The synthetic emoji font cmap-maps '5' WITH a colour glyph — the
        // keycap base trap. A bare '5' is text presentation: it must draw
        // from the text side (Fallback Sans), never in colour. Its edges
        // anti-alias, so every non-transparent pixel must be red — not
        // exactly one red value.
        let out = render(&fonts(), &emoji_chain(), &spec("5", 100.0)).unwrap();
        let seen = colours(&out.image);
        assert!(
            seen.iter().all(|c| c[0] == 255 && c[1] == 0 && c[2] == 0),
            "mono red only: {seen:?}"
        );
        assert!(!seen.is_empty(), "the digit inks at all");
    }

    #[test]
    fn vs16_flips_a_text_presentation_character_into_colour() {
        // ❤ is text presentation by itself (tofu from the chosen font in
        // these fixtures); with VS16 the emoji font's colour heart wins.
        let bare = render(&fonts(), &emoji_chain(), &spec("❤", 100.0)).unwrap();
        assert!(colours(&bare.image).is_empty(), "no emoji font drawn for a bare heart");
        let flipped = render(&fonts(), &emoji_chain(), &spec("❤\u{FE0F}", 100.0)).unwrap();
        assert!(!colours(&flipped.image).is_empty(), "VS16 asks for the colour presentation");
    }

    #[test]
    fn a_stray_joiner_or_selector_draws_nothing() {
        // ZWJ and VS16 that nothing consumes are default-ignorable.
        let plain = render(&fonts(), &emoji_chain(), &spec("A", 100.0)).unwrap();
        for joined in ["A\u{200D}", "A\u{FE0F}", "A\u{200D}\u{FE0F}"] {
            let out = render(&fonts(), &emoji_chain(), &spec(joined, 100.0)).unwrap();
            assert_eq!(out.image.width, plain.image.width, "{joined:?} adds no advance");
            assert_eq!(colours(&out.image).len(), 1, "{joined:?} adds no colour");
        }
    }

    #[test]
    fn the_real_bundled_fonts_render_colour_emoji() {
        // The committed Noto and Twemoji fonts (SPM-17's assets): a
        // Unicode-15 hand and a grinning face must draw in colour — the
        // Windows-test bug (CMT-176) stays fixed on the canvas side.
        for (source, text) in [("noto", "🫵"), ("twemoji", "😀")] {
            let file = format!("fonts/{}.ttf", if source == "noto" { "Noto-COLRv1" } else { "Twemoji_COLRv1" });
            let chain = EmojiFonts::new(vec![EmojiSource::Bytes(bundled_bytes(&file))]);
            let out = render(&fonts(), &chain, &spec(text, 100.0)).unwrap();
            assert!(colours(&out.image).len() > 1, "{source} draws more than one colour");
            assert!(out.image.pixels.chunks(4).any(|p| p[3] > 0), "{source} inks");
        }
    }

    #[test]
    fn emoji_runs_ligate_in_the_real_fonts() {
        // A family emoji is ONE colour glyph in Noto (plain GSUB
        // ligatures, no shaping), and a keycap ligates with the VS16
        // dropped — Noto does not cmap-map VS16 at all, so its ligature
        // is 5 + keycap mark directly (the browser's shaper drops
        // unmapped default-ignorables the same way).
        let db = fonts();
        let chain = EmojiFonts::new(vec![EmojiSource::Bytes(bundled_bytes("fonts/Noto-COLRv1.ttf"))]);
        let family: Vec<char> = "👨‍👩‍👧‍👦".chars().collect();
        let glyphs = chain.resolve_run(&db, &family, 100.0).expect("Noto ligates the family sequence");
        assert_eq!(glyphs.len(), 1, "the four-person run reduces to one glyph");
        let single = chain.resolve_run(&db, &['😀'], 100.0).unwrap();
        let keycap: Vec<char> = "5\u{FE0F}\u{20E3}".chars().collect();
        let keyed = chain.resolve_run(&db, &keycap, 100.0).expect("Noto ligates the keycap");
        assert_eq!(keyed.len(), 1, "the keycap run reduces to one glyph");

        // A flag pair: two regional indicators ligate to one glyph.
        let flag: Vec<char> = "🇫🇷".chars().collect();
        let flagged = chain.resolve_run(&db, &flag, 100.0).expect("Noto ligates the flag pair");
        assert_eq!(flagged.len(), 1, "the flag run reduces to one glyph");
        // A ZWJ glues a text-presentation tail into the run: the man +
        // health worker ligates across ⚕ (which never starts a run alone).
        let worker: Vec<char> = "👨‍⚕️".chars().collect();
        let worked = chain.resolve_run(&db, &worker, 100.0).expect("Noto ligates the profession");
        assert_eq!(worked.len(), 1, "the profession run reduces to one glyph");
        assert!(glyphs[0].advance > 0.0 && single[0].advance > 0.0 && keyed[0].advance > 0.0);
        // And the drawn pixels agree with the resolved advances — the
        // family end to end (run extension included), and the profession
        // the same way, so the ZWJ glue is exercised through render.
        for (text, ligature) in [("👨‍👩‍👧‍👦", &glyphs), ("👨‍⚕️", &worked)] {
            let out = render(&db, &chain, &TextSpec {
                text: text.into(),
                font_family: FAMILY.into(),
                font_size: 100.0,
                color: "#000000".into(),
            })
            .unwrap();
            assert!(
                (out.image.width as f32 - ligature[0].advance).abs() < 2.0,
                "{text}: the box matches the ligature"
            );
        }
    }

    /// Real system fonts (run with `cargo test -- --ignored`): lists the
    /// installed families and draws a line in the first of a few common ones.
    /// On Windows this exercises Impact, Arial or Segoe UI from C:\Windows\Fonts.
    #[test]
    #[ignore = "depends on the machine's installed fonts"]
    fn system_fonts_list_and_render() {
        let fonts = system_fonts();
        let names = families(fonts);
        assert!(!names.is_empty(), "no system fonts found");
        let family = [
            "Impact",
            "Arial",
            "Segoe UI",
            "DejaVu Sans",
            "Liberation Sans",
            "Noto Sans",
            "Ubuntu",
        ]
            .into_iter()
            .find(|f| names.iter().any(|n| n == f))
            .unwrap_or(&names[0]);
        let s = TextSpec { font_family: family.to_string(), ..spec("Hello, sticker! gjpqy", 48.0) };
        let out = render(fonts, &EmojiFonts::empty(), &s).unwrap();
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
        let out = render(&fonts(), &EmojiFonts::empty(), &spec("A", 10.0)).unwrap();
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

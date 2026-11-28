//! Emoji drawing for text layers (SPM-20): the style's emoji font chain,
//! per-character routing and COLR colour painting, all Tauri-free like the
//! rest of the editor core (ADR-0005).
//!
//! The chain mirrors the webview's font stacks (`EMOJI_STYLE_STACKS` in
//! src/emoji-style.ts) with the style's bundled font first: Android (Noto),
//! Twemoji, Windows (system Segoe UI Emoji) or the custom file, then the
//! system emoji fonts behind them. A character whose glyph a chain font
//! covers IN COLOUR is drawn from that font; an emoji font that only has a
//! monochrome glyph is skipped for it (SPEC §5: emoji are never drawn as
//! monochrome outlines), and if no font in the chain colour-covers the
//! character it falls back to the text chain like any other character.
//!
//! Colour painting uses ttf-parser's COLR painter (v0 and v1) over
//! tiny-skia: each layer's outline filled with its CPAL colour or gradient,
//! with the clip, transform and composite-mode stacks the COLRv1 paint
//! graph needs. Angular sweep gradients have no tiny-skia rasteriser; the
//! bundled fonts use none (a guard test pins that). Since SPM-69 a font that
//! carries its colour as bitmaps instead is painted too: CBDT/CBLC (PNG
//! formats 17-19) and PNG sbix both come back from ttf-parser as PNG
//! payloads, so one decode path serves both — the strike nearest at or above
//! the text's size is chosen (the largest when none is that big), scaled and
//! composited in the same tiny-skia path, top-left placed by the strike's own
//! metrics. Large emoji therefore upscale from the font's biggest strike and
//! look slightly soft where it tops out at 96 px (SPEC §6); SVG-in-OpenType
//! stays unpainted (rejected, §9).
//!
//! Emoji runs (ZWJ sequences, flags, keycaps, skin tones) are reduced with
//! the chain font's own plain GSUB ligature lookups — no general shaping
//! (SPM-9's line is kept): what the emoji font ligates, we ligate. A joiner
//! or presentation selector that nothing consumes draws nothing, the
//! browser's default-ignorable behaviour.

use std::collections::HashMap;
use std::sync::Arc;

use fontdb::Database;
use ttf_parser::colr::{ClipBox, CompositeMode, Paint, Painter};
use ttf_parser::{
    Face, GlyphId, RasterGlyphImage, RasterImageFormat, RgbaColor, Transform as FontTransform,
};
use tiny_skia::{
    BlendMode as SkiaBlend, FillRule, FilterQuality, LinearGradient, Mask, Paint as SkiaPaint,
    Path as SkiaPath, PathBuilder, Pattern, Pixmap, PixmapRef, RadialGradient, Shader, SpreadMode,
    Transform as SkiaTransform,
};

#[path = "emoji_data.rs"]
mod emoji_data;
use emoji_data::is_emoji_presentation;

/// One emoji font the style resolved to, in chain order.
#[derive(Clone, Debug)]
pub enum EmojiSource {
    /// Font bytes in memory: a bundled font from the app's assets or the
    /// custom style's file read from its stored path.
    Bytes(Arc<Vec<u8>>),
    /// A system font face (Segoe UI Emoji, an installed Noto), by fontdb id.
    System(fontdb::ID),
}

/// The style-resolved emoji font chain (SPM-20), built per command call by
/// the Tauri layer and passed into the renderer; Tauri-free, unit-testable.
#[derive(Clone, Debug, Default)]
pub struct EmojiFonts {
    sources: Vec<EmojiSource>,
}

impl EmojiFonts {
    /// A chain with nothing in it: every emoji-presentation character falls
    /// back to the text chain (the pre-SPM-20 behaviour).
    pub fn empty() -> Self {
        Self { sources: Vec::new() }
    }

    /// A chain from sources, first tried first.
    pub fn new(sources: Vec<EmojiSource>) -> Self {
        Self { sources }
    }

    /// Run `work` with the source's parsed face. `None` when the source is
    /// not loadable (an unloadable custom font, say) — the chain moves on.
    pub(super) fn with_source<T>(&self, fonts: &Database, index: usize, work: impl FnOnce(&Face) -> T) -> Option<T> {
        match &self.sources[index] {
            // Bundled and custom fonts are single-face .ttf files.
            EmojiSource::Bytes(bytes) => Face::parse(bytes, 0).ok().map(|face| work(&face)),
            EmojiSource::System(id) => fonts
                .with_face_data(*id, |data, index| {
                    Face::parse(data, index).ok().map(|face| work(&face))
                })
                .flatten(),
        }
    }

    /// Resolve an emoji run (all characters in the run domain, SPM-20) into
    /// colour glyphs with their advances in px at `size`, or `None` when no
    /// chain font colour-covers it — the caller then routes each character
    /// through the text fallback chain, dropping bare joiners.
    ///
    /// A single character takes the first font that has a colour glyph for
    /// it. A longer run (a ZWJ sequence, a flag pair, a keycap) is resolved
    /// as a whole: the first font that covers every content character and
    /// whose plain GSUB ligatures reduce the run, with every surviving
    /// glyph a colour glyph, wins. Joiners a ligature does not consume
    /// (Noto does not cmap-map VS16, say) contribute notdef and vanish.
    pub(super) fn resolve_run(&self, fonts: &Database, run: &[char], size: f32) -> Option<Vec<EmojiGlyph>> {
        for index in 0..self.sources.len() {
            // An unloadable source or a face that does not colour-cover the
            // run yields None and the chain moves on; the first source that
            // colour-covers it wins.
            if let Some(glyphs) =
                self.with_source(fonts, index, |face| resolve_in(face, index, run, size)).flatten()
            {
                return Some(glyphs);
            }
        }
        None
    }
}

/// One colour glyph to draw: which chain source, which glyph, how far the
/// pen moves and how its ink scales at the text's size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct EmojiGlyph {
    pub source: usize,
    pub id: GlyphId,
    pub advance: f32,
    /// px per unit of the glyph's ink: a font unit for a COLR glyph, a pixel
    /// of the chosen strike for a bitmap one (SPM-69).
    pub scale: f32,
    /// The strike's pixels per em for a bitmap glyph, `None` for a COLR
    /// glyph: which kind of ink this is, and which strike to paint.
    pub bitmap_ppem: Option<u16>,
}

/// The PNG bitmap strike `glyph_raster_image` selects for `id` at `ppem`, or
/// `None` when the glyph has no image there or the image is not PNG.
///
/// One decode path serves CBDT/CBLC and sbix: ttf-parser reports both as PNG
/// payloads, so painting, measuring and covering all read the same strike
/// here. The other raster formats (mono and BGRA bitmaps) stay unpainted, and
/// a strike that declares no pixels per em has no scale to paint at, so
/// neither is a strike this module can use.
pub(super) fn png_strike<'a>(
    face: &'a Face,
    id: GlyphId,
    ppem: u16,
) -> Option<RasterGlyphImage<'a>> {
    let image = face.glyph_raster_image(id, ppem)?;
    if image.format != RasterImageFormat::PNG || image.pixels_per_em == 0 {
        return None;
    }
    Some(image)
}

/// Resolve a run against one face, or `None` when the face does not
/// colour-cover it (see `EmojiFonts::resolve_run`).
fn resolve_in(face: &Face, source: usize, run: &[char], size: f32) -> Option<Vec<EmojiGlyph>> {
    let upem = face.units_per_em() as f32;
    // Advances are font units whatever the ink is, so they scale by the em.
    let em = size / upem;
    // The strike to ask for: ttf-parser picks the smallest strike at or above
    // this ppem, else the largest (SPM-69's rule for free).
    let ppem = (size.round() as u16).max(1);
    // Glyph ids as the font sees them, each with its ignorable flag. An
    // ignorable the font does not even cmap-map (Noto maps no VS16) is
    // dropped up front, as the browser's shaper drops unmapped
    // default-ignorables: the font's ligatures do not expect it as a
    // component (Noto's keycap is 5 + mark directly), while a mapped one
    // (Noto's ZWJ) is a real component and must stay.
    let mut ids: Vec<(GlyphId, bool)> = Vec::with_capacity(run.len());
    for &c in run {
        let id = face.glyph_index(c);
        if is_ignorable(c) && id.is_none() {
            continue;
        }
        ids.push((id.unwrap_or(GlyphId(0)), is_ignorable(c)));
    }
    if ids.is_empty() {
        return None;
    }
    // The run's surviving glyphs, ligature-reduced. A single glyph cannot
    // ligate with anything: no GSUB walk.
    let items = if ids.len() > 1 { reduce(face, &ids)? } else { vec![ids[0]] };
    let mut glyphs = Vec::with_capacity(items.len());
    for (id, ignorable) in items {
        if ignorable {
            continue; // a joiner nothing consumed: default-ignorable, vanishes
        }
        // Monochrome coverage in an emoji font is not emoji drawing
        // (SPEC §5): a font that only outlines the character loses it. COLR
        // layers are preferred — sharp at any size — and since SPM-69 a PNG
        // bitmap strike stands in for them: the glyph's ink is then the
        // strike's pixels, scaled from the strike rather than the em.
        let (scale, bitmap_ppem) = if face.is_color_glyph(id) {
            (em, None)
        } else {
            let image = png_strike(face, id, ppem)?;
            (size / image.pixels_per_em as f32, Some(image.pixels_per_em))
        };
        let advance = face.glyph_hor_advance(id)? as f32 * em;
        glyphs.push(EmojiGlyph { source, id, advance, scale, bitmap_ppem });
    }
    Some(glyphs)
}

/// Greedy left-to-right ligature reduction of a run's glyph sequence: at
/// each position, the FIRST stored ligature whose components match wins,
/// exactly as a no-shaping engine applies a plain LookupType-4. After the
/// unmapped-ignorable pre-drop, a notdef means a real content character
/// this font lacks, so the face does not cover the run.
fn reduce(face: &Face, ids: &[(GlyphId, bool)]) -> Option<Vec<(GlyphId, bool)>> {
    let mut ligatures = LigatureCache::new(face);
    let mut out = Vec::with_capacity(ids.len());
    let mut i = 0;
    while i < ids.len() {
        if let Some((lig, len)) = ligatures.ligate(&ids[i..]) {
            out.push((lig, false));
            i += len + 1;
            continue;
        }
        if ids[i].0 == GlyphId(0) {
            return None; // a content character this font lacks
        }
        out.push(ids[i]);
        i += 1;
    }
    Some(out)
}

/// A run character that draws nothing when nothing consumes it: the joiner
/// and the presentation selector (the browser's default-ignorables).
fn is_ignorable(c: char) -> bool {
    is_zwj(c) || is_vs16(c)
}

/// Plain GSUB ligature substitutions (LookupType 4) looked up by first
/// glyph and cached: first glyph id -> its ligatures in stored order, each
/// as (ligature glyph, component glyph ids after the first). No features,
/// no context: emoji fonts ligate emoji runs with plain lookups, which is
/// the no-shaping allowance this module takes. Ligatures from notdef are
/// skipped: no font ligates real content out of notdef.
struct LigatureCache<'a, 'f> {
    face: &'a Face<'f>,
    cache: HashMap<GlyphId, Vec<(GlyphId, Vec<GlyphId>)>>,
}

impl<'a, 'f> LigatureCache<'a, 'f> {
    fn new(face: &'a Face<'f>) -> Self {
        Self { face, cache: HashMap::new() }
    }

    /// The first ligature at the head of `ids` (first glyph included) that
    /// the font stores, with how many glyphs it consumes.
    fn ligate(&mut self, ids: &[(GlyphId, bool)]) -> Option<(GlyphId, usize)> {
        let face = self.face;
        let set = self
            .cache
            .entry(ids[0].0)
            .or_insert_with(|| ligatures_for(face, ids[0].0));
        for (lig, components) in set {
            let covered = ids.len() > components.len()
                && ids[1..=components.len()].iter().map(|(g, _)| *g).eq(components.iter().copied());
            if covered {
                return Some((*lig, components.len()));
            }
        }
        None
    }
}

/// One first glyph's ligatures from every plain ligature lookup in the
/// face, in stored order.
fn ligatures_for(face: &Face, first: GlyphId) -> Vec<(GlyphId, Vec<GlyphId>)> {
    let mut out = Vec::new();
    let Some(gsub) = face.tables().gsub else { return out };
    for i in 0..gsub.lookups.len() {
        let Some(lookup) = gsub.lookups.get(i) else { continue };
        for s in 0..lookup.subtables.len() {
            let Some(ttf_parser::gsub::SubstitutionSubtable::Ligature(table)) =
                lookup.subtables.get::<ttf_parser::gsub::SubstitutionSubtable>(s)
            else {
                continue;
            };
            // Coverage maps the first glyph to its ligature set.
            let Some(set_index) = table.coverage.get(first) else { continue };
            let Some(set) = table.ligature_sets.get(set_index) else { continue };
            for l in 0..set.len() {
                if let Some(lig) = set.get(l) {
                    if lig.glyph != GlyphId(0) {
                        out.push((lig.glyph, lig.components.into_iter().collect()));
                    }
                }
            }
        }
    }
    out
}

// ---- Routing predicates (the run domain) ----

/// Whether a character starts an emoji run: anything that defaults to
/// emoji presentation (regional indicators included) or a lone skin tone
/// (browsers swatch those from the emoji font).
pub(super) fn starts_emoji_run(c: char) -> bool {
    is_emoji_presentation(c) || is_skin_tone(c)
}

/// Whether a character may JOIN one: the starters, ZWJ, VS16 (which can
/// also flip the character before it into the run), a skin tone or the
/// combining keycap mark.
pub(super) fn continues_emoji_run(c: char) -> bool {
    starts_emoji_run(c) || is_zwj(c) || is_vs16(c) || is_keycap_mark(c)
}

pub(super) fn is_vs16(c: char) -> bool {
    c == '\u{FE0F}'
}

pub(super) fn is_zwj(c: char) -> bool {
    c == '\u{200D}'
}

fn is_skin_tone(c: char) -> bool {
    matches!(c, '\u{1F3FB}'..='\u{1F3FF}')
}

fn is_keycap_mark(c: char) -> bool {
    c == '\u{20E3}'
}

// ---- Colour glyph painting ----

/// The ink box of a colour glyph in font units (y up), or `None` when the
/// glyph has no colour definition. Painted ink only: clips only remove.
pub(super) fn colour_glyph_bounds(face: &Face, id: GlyphId) -> Option<(f32, f32, f32, f32)> {
    let mut painter = BoundsPainter { face, ctm: FontTransform::default(), stack: Vec::new(), total: None };
    face.paint_color_glyph(id, 0, RgbaColor::new(0, 0, 0, 255), &mut painter)?;
    painter.total
}

/// The ink box of a BITMAP glyph in the chosen strike's pixels (y up), or
/// `None` when the glyph has no PNG image in a strike. The same left/bottom/
/// right/top box `colour_glyph_bounds` gives in font units, so the caller's
/// ink arithmetic is identical — only the unit its scale converts differs.
///
/// ttf-parser reports `x` as the image's left edge from the pen origin and
/// `y` as its BOTTOM edge above the baseline (it converts CBDT's bearing-Y to
/// that bound; sbix states the same edge directly, as `originOffsetY`), so
/// `y + height` is the image's top.
pub(super) fn bitmap_glyph_bounds(
    face: &Face,
    id: GlyphId,
    ppem: u16,
) -> Option<(f32, f32, f32, f32)> {
    let image = png_strike(face, id, ppem)?;
    let (x, y) = (f32::from(image.x), f32::from(image.y));
    Some((x, y, x + f32::from(image.width), y + f32::from(image.height)))
}

/// A painter that only tracks ink: the outline boxes of the glyphs the COLR
/// graph outlines, transformed by the graph's own transform stack into
/// top-level font units. Control paints (gradients) and clips are ignored:
/// they never ADD ink beyond the outlines they paint.
struct BoundsPainter<'a> {
    face: &'a Face<'a>,
    ctm: FontTransform,
    stack: Vec<FontTransform>,
    total: Option<(f32, f32, f32, f32)>,
}

impl BoundsPainter<'_> {
    fn union(&mut self, id: GlyphId) {
        if let Some(rect) = outline_box(self.face, id) {
            let (x0, y0, x1, y1) = rect;
            for (x, y) in [(x0, y0), (x0, y1), (x1, y0), (x1, y1)] {
                let (x, y) = apply(self.ctm, x, y);
                self.total = Some(match self.total {
                    None => (x, y, x, y),
                    Some((a, b, c, d)) => (a.min(x), b.min(y), c.max(x), d.max(y)),
                });
            }
        }
    }
}

fn apply(t: FontTransform, x: f32, y: f32) -> (f32, f32) {
    (t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f)
}

/// `first` applied before `second` (font-unit affine composition): the
/// matrix product `second * first`, translation kept out of the linear
/// terms (a stray `+e/+f` in `a..d` scales the ink absurdly under nested
/// transforms).
fn compose(second: FontTransform, first: FontTransform) -> FontTransform {
    FontTransform {
        a: second.a * first.a + second.c * first.b,
        b: second.b * first.a + second.d * first.b,
        c: second.a * first.c + second.c * first.d,
        d: second.b * first.c + second.d * first.d,
        e: second.a * first.e + second.c * first.f + second.e,
        f: second.b * first.e + second.d * first.f + second.f,
    }
}

/// A glyph's outline box in font units via a no-op builder (the outline
/// call returns the bounds).
fn outline_box(face: &Face, id: GlyphId) -> Option<(f32, f32, f32, f32)> {
    struct NoBuild;
    impl ttf_parser::OutlineBuilder for NoBuild {
        fn move_to(&mut self, _: f32, _: f32) {}
        fn line_to(&mut self, _: f32, _: f32) {}
        fn quad_to(&mut self, _: f32, _: f32, _: f32, _: f32) {}
        fn curve_to(&mut self, _: f32, _: f32, _: f32, _: f32, _: f32, _: f32) {}
        fn close(&mut self) {}
    }
    let r = face.outline_glyph(id, &mut NoBuild)?;
    Some((r.x_min as f32, r.y_min as f32, r.x_max as f32, r.y_max as f32))
}

impl Painter<'_> for BoundsPainter<'_> {
    fn outline_glyph(&mut self, id: GlyphId) {
        self.union(id);
    }
    fn paint(&mut self, _: Paint) {}
    fn push_clip(&mut self) {}
    fn push_clip_box(&mut self, _: ClipBox) {}
    fn pop_clip(&mut self) {}
    fn push_layer(&mut self, _: CompositeMode) {}
    fn pop_layer(&mut self) {}
    fn push_transform(&mut self, transform: FontTransform) {
        self.stack.push(self.ctm);
        self.ctm = compose(self.ctm, transform);
    }
    fn pop_transform(&mut self) {
        self.ctm = self.stack.pop().unwrap_or_default();
    }
}

/// The drawing painter: fills each outlined layer into the canvas (or the
/// open offscreen layer) with its paint, honouring the clip, transform and
/// composite-mode stacks. Outlines are stored in font units; the placement
/// (the base transform, font units -> device) is supplied at construction.
pub(super) struct DrawPainter<'a> {
    face: &'a Face<'a>,
    /// Font units -> device for this glyph's placement.
    base: SkiaTransform,
    canvas: &'a mut Pixmap,
    /// The COLRv1 transform stack on top of the base, in font units.
    ctm: FontTransform,
    ctm_stack: Vec<FontTransform>,
    /// Device-space clip masks, outermost first; empty = no clipping.
    clips: Vec<Mask>,
    /// Open offscreen layers (innermost last) with their composite mode.
    layers: Vec<(Pixmap, CompositeMode)>,
    /// The last outlined glyph, in font units.
    stored: Option<SkiaPath>,
}

impl<'a> DrawPainter<'a> {
    pub(super) fn new(face: &'a Face<'a>, canvas: &'a mut Pixmap, base: SkiaTransform) -> Self {
        Self {
            face,
            base,
            canvas,
            ctm: FontTransform::default(),
            ctm_stack: Vec::new(),
            clips: Vec::new(),
            layers: Vec::new(),
            stored: None,
        }
    }

    /// Font units -> device for the current transform stack.
    fn device(&self) -> SkiaTransform {
        self.base.pre_concat(to_skia(self.ctm))
    }

    /// Where painting goes: the innermost open layer, else the canvas.
    /// (Field-disjoint borrows let the clip be passed alongside.)
    fn fill_target(&mut self, path: &SkiaPath, paint: &SkiaPaint) {
        let transform = self.device();
        match self.layers.last_mut() {
            Some((pixmap, _)) => {
                pixmap.fill_path(path, paint, FillRule::Winding, transform, self.clips.last())
            }
            None => {
                self.canvas.fill_path(path, paint, FillRule::Winding, transform, self.clips.last())
            }
        }
    }

    /// Fill the stored outline with a paint.
    fn fill_stored(&mut self, paint: &SkiaPaint) {
        if let Some(path) = self.stored.clone() {
            self.fill_target(&path, paint);
        }
    }

    /// Intersect the clip stack with `path` (font units, transformed by the
    /// current transform).
    fn push_mask(&mut self, path: &SkiaPath) {
        let transform = self.device();
        let (width, height) = (self.canvas.width(), self.canvas.height());
        let mask = match self.clips.last() {
            None => {
                let Some(mut mask) = Mask::new(width, height) else { return };
                mask.fill_path(path, FillRule::Winding, true, transform);
                mask
            }
            Some(outer) => {
                let mut mask = outer.clone();
                mask.intersect_path(path, FillRule::Winding, true, transform);
                mask
            }
        };
        self.clips.push(mask);
    }

    /// The shader for a gradient paint, in device space; solid fills are
    /// handled by the caller as colour paints.
    fn gradient_shader(&self, paint: &Paint) -> Option<Shader<'static>> {
        let device = self.device();
        match paint {
            Paint::Solid(_) => None,
            Paint::LinearGradient(g) => {
                let stops = gradient_stops(g.stops(0, &[]));
                // COLR's third point rotates the line: when P2 differs from
                // P0 the gradient runs from P0 toward P2 and P1 is
                // orthogonally projected onto that line; P2 = P0 (the
                // bundled fonts' case) is the plain P0 -> P1 line.
                let (x0, y0) = map(device, g.x0, g.y0);
                let (x1, y1) = map(device, g.x1, g.y1);
                let (x2, y2) = map(device, g.x2, g.y2);
                let (ex, ey) = if (x2, y2) == (x0, y0) {
                    (x1, y1)
                } else {
                    let (dx, dy) = (x2 - x0, y2 - y0);
                    let t = ((x1 - x0) * dx + (y1 - y0) * dy) / (dx * dx + dy * dy);
                    (x0 + t * dx, y0 + t * dy)
                };
                LinearGradient::new(
                    tiny_skia::Point::from_xy(x0, y0),
                    tiny_skia::Point::from_xy(ex, ey),
                    stops,
                    spread(g.extend),
                    SkiaTransform::default(),
                )
            }
            Paint::RadialGradient(g) => {
                let stops = gradient_stops(g.stops(0, &[]));
                // Radii scale by the (uniform, y-flipped) device scale.
                let scale = device.sx.max(device.sy.abs());
                let (x0, y0) = map(device, g.x0, g.y0);
                let (x1, y1) = map(device, g.x1, g.y1);
                RadialGradient::new(
                    tiny_skia::Point::from_xy(x0, y0),
                    g.r0 * scale,
                    tiny_skia::Point::from_xy(x1, y1),
                    g.r1 * scale,
                    stops,
                    spread(g.extend),
                    SkiaTransform::default(),
                )
            }
            // No angular-sweep rasteriser in tiny-skia; the bundled fonts
            // sweep nothing (the guard test pins that), and a font that
            // changes it will trip the test before shipping.
            Paint::SweepGradient(g) => {
                let _ = g;
                None
            }
        }
    }
}

fn map(t: SkiaTransform, x: f32, y: f32) -> (f32, f32) {
    (t.sx * x + t.kx * y + t.tx, t.ky * x + t.sy * y + t.ty)
}

fn to_skia(t: FontTransform) -> SkiaTransform {
    SkiaTransform::from_row(t.a, t.b, t.c, t.d, t.e, t.f)
}

fn gradient_stops(iter: ttf_parser::colr::GradientStopsIter) -> Vec<tiny_skia::GradientStop> {
    iter.map(|stop| {
        tiny_skia::GradientStop::new(
            stop.stop_offset,
            tiny_skia::Color::from_rgba8(
                stop.color.red,
                stop.color.green,
                stop.color.blue,
                stop.color.alpha,
            ),
        )
    })
    .collect()
}

fn spread(extend: ttf_parser::colr::GradientExtend) -> SpreadMode {
    match extend {
        ttf_parser::colr::GradientExtend::Pad => SpreadMode::Pad,
        ttf_parser::colr::GradientExtend::Repeat => SpreadMode::Repeat,
        ttf_parser::colr::GradientExtend::Reflect => SpreadMode::Reflect,
    }
}

impl<'a> Painter<'a> for DrawPainter<'a> {
    fn outline_glyph(&mut self, id: GlyphId) {
        self.stored = outline_path(self.face, id);
    }

    fn paint(&mut self, paint: Paint<'a>) {
        match paint {
            Paint::Solid(color) => {
                let mut skia = SkiaPaint::default();
                skia.set_color_rgba8(color.red, color.green, color.blue, color.alpha);
                skia.anti_alias = true;
                self.fill_stored(&skia);
            }
            gradient => {
                if let Some(shader) = self.gradient_shader(&gradient) {
                    let skia = SkiaPaint { shader, anti_alias: true, ..Default::default() };
                    self.fill_stored(&skia);
                }
            }
        }
    }

    fn push_clip(&mut self) {
        if let Some(path) = self.stored.clone() {
            self.push_mask(&path);
        }
    }

    fn push_clip_box(&mut self, clipbox: ClipBox) {
        let Some(rect) = tiny_skia::Rect::from_ltrb(
            clipbox.x_min,
            clipbox.y_min,
            clipbox.x_max,
            clipbox.y_max,
        ) else {
            // A degenerate box (malformed font data) clips everything, as
            // an empty rectangle would — never MORE ink than the font asked.
            if let Some(empty) = Mask::new(self.canvas.width(), self.canvas.height()) {
                self.clips.push(empty);
            }
            return;
        };
        let path = PathBuilder::from_rect(rect);
        self.push_mask(&path);
    }

    fn pop_clip(&mut self) {
        self.clips.pop();
    }

    fn push_layer(&mut self, mode: CompositeMode) {
        if let Some(pixmap) = Pixmap::new(self.canvas.width(), self.canvas.height()) {
            self.layers.push((pixmap, mode));
        }
    }

    fn pop_layer(&mut self) {
        let Some((child, mode)) = self.layers.pop() else { return };
        let Some(rect) =
            tiny_skia::Rect::from_xywh(0.0, 0.0, child.width() as f32, child.height() as f32)
        else {
            return;
        };
        let rect = PathBuilder::from_rect(rect);
        let Some(pixmap) = PixmapRef::from_bytes(child.data(), child.width(), child.height()) else {
            return;
        };
        let shader = Pattern::new(
            pixmap,
            SpreadMode::Pad,
            FilterQuality::Nearest,
            1.0,
            SkiaTransform::identity(),
        );
        let paint =
            SkiaPaint { shader, blend_mode: skia_blend(mode), anti_alias: false, ..Default::default() };
        // The child composites onto the parent under the current clip.
        let clip = self.clips.last().cloned();
        let transform = self.device();
        match self.layers.last_mut() {
            Some((pixmap, _)) => {
                pixmap.fill_path(&rect, &paint, FillRule::Winding, transform, clip.as_ref())
            }
            None => self.canvas.fill_path(&rect, &paint, FillRule::Winding, transform, clip.as_ref()),
        }
    }

    fn push_transform(&mut self, transform: FontTransform) {
        self.ctm_stack.push(self.ctm);
        self.ctm = compose(self.ctm, transform);
    }

    fn pop_transform(&mut self) {
        self.ctm = self.ctm_stack.pop().unwrap_or_default();
    }
}

fn skia_blend(mode: CompositeMode) -> SkiaBlend {
    use ttf_parser::colr::CompositeMode as M;
    // The two enums carry the same 28-mode list under the same names
    // (tiny-skia has Modulate extra, COLR never emits it).
    match mode {
        M::Clear => SkiaBlend::Clear,
        M::Source => SkiaBlend::Source,
        M::Destination => SkiaBlend::Destination,
        M::SourceOver => SkiaBlend::SourceOver,
        M::DestinationOver => SkiaBlend::DestinationOver,
        M::SourceIn => SkiaBlend::SourceIn,
        M::DestinationIn => SkiaBlend::DestinationIn,
        M::SourceOut => SkiaBlend::SourceOut,
        M::DestinationOut => SkiaBlend::DestinationOut,
        M::SourceAtop => SkiaBlend::SourceAtop,
        M::DestinationAtop => SkiaBlend::DestinationAtop,
        M::Xor => SkiaBlend::Xor,
        M::Plus => SkiaBlend::Plus,
        M::Screen => SkiaBlend::Screen,
        M::Overlay => SkiaBlend::Overlay,
        M::Darken => SkiaBlend::Darken,
        M::Lighten => SkiaBlend::Lighten,
        M::ColorDodge => SkiaBlend::ColorDodge,
        M::ColorBurn => SkiaBlend::ColorBurn,
        M::HardLight => SkiaBlend::HardLight,
        M::SoftLight => SkiaBlend::SoftLight,
        M::Difference => SkiaBlend::Difference,
        M::Exclusion => SkiaBlend::Exclusion,
        M::Multiply => SkiaBlend::Multiply,
        M::Hue => SkiaBlend::Hue,
        M::Saturation => SkiaBlend::Saturation,
        M::Color => SkiaBlend::Color,
        M::Luminosity => SkiaBlend::Luminosity,
    }
}

/// A glyph's outline as a tiny-skia path in font units (y up, as stored).
fn outline_path(face: &Face, id: GlyphId) -> Option<SkiaPath> {
    struct Build(PathBuilder);
    impl ttf_parser::OutlineBuilder for Build {
        fn move_to(&mut self, x: f32, y: f32) {
            self.0.move_to(x, y);
        }
        fn line_to(&mut self, x: f32, y: f32) {
            self.0.line_to(x, y);
        }
        fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
            self.0.quad_to(cx, cy, x, y);
        }
        fn curve_to(&mut self, c1x: f32, c1y: f32, c2x: f32, c2y: f32, x: f32, y: f32) {
            self.0.cubic_to(c1x, c1y, c2x, c2y, x, y);
        }
        fn close(&mut self) {
            self.0.close();
        }
    }
    let mut build = Build(PathBuilder::new());
    face.outline_glyph(id, &mut build)?;
    build.0.finish()
}

/// The bundled fonts' bytes for tests (SPM-17's committed assets under
/// public/fonts), shared with text.rs's tests.
#[cfg(test)]
pub(crate) fn bundled_bytes(path: &str) -> std::sync::Arc<Vec<u8>> {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public").join(path);
    std::sync::Arc::new(std::fs::read(&file).expect("the bundled fonts are committed to the repo"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::emoji_bitmap_test_font;
    use crate::editor::emoji_test_font;

    /// A painter that only records which paint kinds a colour glyph uses.
    struct KindProbe {
        sweeps: bool,
    }

    impl Painter<'_> for KindProbe {
        fn outline_glyph(&mut self, _: GlyphId) {}
        fn paint(&mut self, paint: Paint) {
            if matches!(paint, Paint::SweepGradient(_)) {
                self.sweeps = true;
            }
        }
        fn push_clip(&mut self) {}
        fn push_clip_box(&mut self, _: ClipBox) {}
        fn pop_clip(&mut self) {}
        fn push_layer(&mut self, _: CompositeMode) {}
        fn pop_layer(&mut self) {}
        fn push_transform(&mut self, _: FontTransform) {}
        fn pop_transform(&mut self) {}
    }

    /// The module's sweep limit, pinned: tiny-skia has no angular-gradient
    /// rasteriser, so the day a bundled font starts sweeping, this fails
    /// before anything ships. Walks every colour glyph of both fonts.
    #[test]
    fn the_bundled_fonts_sweep_nothing() {
        for name in ["fonts/Noto-COLRv1.ttf", "fonts/Twemoji_COLRv1.ttf"] {
            let bytes = bundled_bytes(name);
            let face = Face::parse(&bytes, 0).unwrap();
            let mut probe = KindProbe { sweeps: false };
            for id in 0..face.number_of_glyphs() {
                let id = GlyphId(id);
                if face.is_color_glyph(id) {
                    face.paint_color_glyph(id, 0, RgbaColor::new(0, 0, 0, 255), &mut probe);
                }
            }
            assert!(!probe.sweeps, "{name} uses a sweep gradient, which we cannot rasterise");
        }
    }

    /// The chain walk: an unloadable first font and one that does not
    /// colour-cover the run are both skipped, and the first source that
    /// colour-covers it wins (the synthetic font lacks U+1FAF5; the
    /// committed Noto covers it, CMT-176's hand).
    #[test]
    fn the_chain_skips_unloadable_and_non_covering_sources() {
        let db = fontdb::Database::new();
        let broken = EmojiSource::Bytes(std::sync::Arc::new(b"not a font at all".to_vec()));
        let chain = EmojiFonts::new(vec![
            broken,
            EmojiSource::Bytes(std::sync::Arc::new(emoji_test_font::bytes())),
            EmojiSource::Bytes(bundled_bytes("fonts/Noto-COLRv1.ttf")),
        ]);
        // The synthetic font covers the grinning face: source 1 wins.
        let grin: Vec<char> = "😀".chars().collect();
        let glyphs = chain.resolve_run(&db, &grin, 100.0).expect("the second source covers it");
        assert_eq!(glyphs[0].source, 1, "the broken first source is skipped");
        // It lacks the Unicode-15 hand: source 2 (the real Noto) wins.
        let hand: Vec<char> = "🫵".chars().collect();
        let glyphs = chain.resolve_run(&db, &hand, 100.0).expect("the third source covers it");
        assert_eq!(glyphs[0].source, 2, "the non-covering second source is skipped");
    }

    // ---- SPM-69: bitmap (CBDT/CBLC and sbix) coverage ----

    /// The hand-built CBLC/CBDT bytes really are a two-strike PNG bitmap font:
    /// both strikes parse through the one `glyph_raster_image` call with the
    /// metrics the fixture declares, which is what the painting tests lean on.
    #[test]
    fn the_bitmap_fixture_parses_its_two_strikes() {
        let bytes = emoji_bitmap_test_font::bytes();
        let face = Face::parse(&bytes, 0).unwrap();
        let id = face.glyph_index('😀').expect("the fixture maps the grinning face");
        assert_eq!(face.glyph_hor_advance(id), Some(1000));
        assert!(!face.is_color_glyph(id), "the fixture carries no COLR layers");
        // (strike ppem, left edge, bottom edge, side) — the 32 ppem strike is
        // offset right of the pen and above the baseline, the 96 ppem one
        // sits on it.
        for (ppem, x, y, side) in [(32u16, 8i16, 4i16, 32u16), (96, 0, 0, 96)] {
            let image = face.glyph_raster_image(id, ppem).expect("a strike");
            assert_eq!(image.format, RasterImageFormat::PNG);
            assert_eq!((image.x, image.y), (x, y), "left edge and bottom edge at {ppem} ppem");
            assert_eq!((image.width, image.height), (side, side), "the image's side");
            assert_eq!(image.pixels_per_em, ppem, "the strike the request selected");
            assert_eq!(&image.data[..4], b"\x89PNG", "a PNG payload, as the painter expects");
        }
        // The ink box the layout grows the text's box by: the same
        // (x0, y0, x1, y1) box as a COLR glyph's, in the strike's pixels.
        assert_eq!(bitmap_glyph_bounds(&face, id, 32), Some((8.0, 4.0, 40.0, 36.0)));
        assert_eq!(bitmap_glyph_bounds(&face, id, 96), Some((0.0, 0.0, 96.0, 96.0)));
        assert_eq!(bitmap_glyph_bounds(&face, GlyphId(0), 32), None, "notdef carries no bitmap");
    }

    /// A bitmap-ONLY font colour-covers its glyph (SPM-69). Before this the
    /// chain demanded `is_color_glyph` (COLR), so a bitmap face lost every
    /// run and the text fell back to the bundled Noto.
    #[test]
    fn a_bitmap_only_font_colour_covers_its_glyph() {
        let db = fontdb::Database::new();
        let chain = EmojiFonts::new(vec![EmojiSource::Bytes(std::sync::Arc::new(
            emoji_bitmap_test_font::bytes(),
        ))]);
        let grin: Vec<char> = "😀".chars().collect();
        // Size 100 against strikes of 32 and 96: nothing at or above 100, so
        // the largest (96) is chosen, and the ink scales from it, not the em.
        let glyphs = chain.resolve_run(&db, &grin, 100.0).expect("the bitmap chain covers it");
        assert_eq!((glyphs.len(), glyphs[0].source, glyphs[0].bitmap_ppem), (1, 0, Some(96)));
        assert_eq!(glyphs[0].advance, 100.0, "the advance still scales by the em");
        assert!((glyphs[0].scale - 100.0 / 96.0).abs() < 1e-4, "the ink scales from the strike");
        // Size 32 asks for 32 ppem exactly: the at-or-above strike, scale 1.
        let glyphs = chain.resolve_run(&db, &grin, 32.0).unwrap();
        assert_eq!((glyphs[0].bitmap_ppem, glyphs[0].scale), (Some(32), 1.0));
        // Two characters with no ligature in the fixture: a ligature-free
        // run keeps both glyphs and both advances.
        let pair: Vec<char> = "😀😀".chars().collect();
        let glyphs = chain.resolve_run(&db, &pair, 32.0).expect("both characters resolve");
        assert_eq!(glyphs.len(), 2, "no ligature: one glyph per character");
        assert_eq!(glyphs.iter().map(|g| g.advance).sum::<f32>(), 64.0);
        // A character the fixture does not map stays uncovered, so the caller
        // falls back exactly as before.
        assert!(chain.resolve_run(&db, &['A'], 32.0).is_none());
        // In chain order the bitmap face wins over the real Noto behind it:
        // no fallback, the custom font draws.
        let chain = EmojiFonts::new(vec![
            EmojiSource::Bytes(std::sync::Arc::new(emoji_bitmap_test_font::bytes())),
            EmojiSource::Bytes(bundled_bytes("fonts/Noto-COLRv1.ttf")),
        ]);
        let glyphs = chain.resolve_run(&db, &grin, 100.0).unwrap();
        assert_eq!((glyphs[0].source, glyphs[0].bitmap_ppem), (0, Some(96)));
    }

    /// A COLR glyph still reports the COLR kind, so the sharp vector path
    /// keeps winning where a font has both (and unchanged where it has COLR
    /// alone).
    #[test]
    fn a_colr_glyph_carries_no_bitmap_strike() {
        let db = fontdb::Database::new();
        let chain = EmojiFonts::new(vec![EmojiSource::Bytes(std::sync::Arc::new(
            emoji_test_font::bytes(),
        ))]);
        let grin: Vec<char> = "😀".chars().collect();
        let glyphs = chain.resolve_run(&db, &grin, 100.0).expect("the COLR font covers it");
        assert_eq!(glyphs[0].bitmap_ppem, None);
        assert_eq!(glyphs[0].scale, 0.1, "font units at a 100 px em on 1000 upem");
    }

    /// The hand-built sbix bytes really are a one-strike PNG bitmap font, and
    /// `glyph_raster_image` reads Apple's table with the metrics the fixture
    /// declares: the origin offsets are the left and bottom edge the CBDT
    /// path reports through its bearings, so the same placement math holds.
    #[test]
    fn the_sbix_fixture_parses_its_strike() {
        let bytes = emoji_bitmap_test_font::sbix_bytes();
        let face = Face::parse(&bytes, 0).unwrap();
        // sbix alone: ttf-parser asks sbix before CBDT, so a font carrying
        // both would never tell these tests anything about sbix.
        assert!(face.tables().sbix.is_some());
        assert!(face.tables().cbdt.is_none(), "an sbix-only bitmap face");
        let id = face.glyph_index('😀').expect("the fixture maps the grinning face");
        assert_eq!(face.glyph_hor_advance(id), Some(1000));
        assert!(!face.is_color_glyph(id), "the fixture carries no COLR layers");
        let image = face.glyph_raster_image(id, 64).expect("the single strike");
        assert_eq!(image.format, RasterImageFormat::PNG);
        assert_eq!((image.x, image.y), (4, 2), "left edge and bottom edge");
        assert_eq!((image.width, image.height), (16, 16), "the image's side");
        assert_eq!(image.pixels_per_em, 64, "the strike's declared ppem");
        assert_eq!(&image.data[..4], b"\x89PNG", "a PNG payload, as the painter expects");
        assert_eq!(bitmap_glyph_bounds(&face, id, 64), Some((4.0, 2.0, 20.0, 18.0)));
        assert_eq!(bitmap_glyph_bounds(&face, GlyphId(0), 64), None, "notdef carries no bitmap");
    }

    /// A bitmap-ONLY sbix font colour-covers its glyph (SPM-69): the strike
    /// stands in for the COLR layers the chain used to demand, and the ink
    /// scales from the strike like any other bitmap.
    #[test]
    fn an_sbix_only_font_colour_covers_its_glyph() {
        let db = fontdb::Database::new();
        let chain = EmojiFonts::new(vec![EmojiSource::Bytes(std::sync::Arc::new(
            emoji_bitmap_test_font::sbix_bytes(),
        ))]);
        let grin: Vec<char> = "😀".chars().collect();
        // 64 px against the 64 ppem strike: the strike is painted 1:1.
        let glyphs = chain.resolve_run(&db, &grin, 64.0).expect("the sbix chain covers it");
        assert_eq!((glyphs.len(), glyphs[0].source), (1, 0));
        assert_eq!(glyphs[0].bitmap_ppem, Some(64));
        assert_eq!(glyphs[0].advance, 64.0, "the advance still scales by the em");
        assert_eq!(glyphs[0].scale, 1.0, "the ink scales from the strike");
        // Size 100 asks past the only strike: it still paints 64 ppem, and
        // the ink scales up from it rather than from the em.
        let glyphs = chain.resolve_run(&db, &grin, 100.0).unwrap();
        assert_eq!(glyphs[0].bitmap_ppem, Some(64));
        assert!((glyphs[0].scale - 100.0 / 64.0).abs() < 1e-4);
    }

    /// A glyph the sbix face has no image for stays uncovered, so the chain
    /// moves on exactly as it does for a character the font does not map.
    #[test]
    fn a_glyph_with_no_sbix_image_stays_uncovered() {
        let db = fontdb::Database::new();
        let sbix = EmojiFonts::new(vec![EmojiSource::Bytes(std::sync::Arc::new(
            emoji_bitmap_test_font::sbix_bytes(),
        ))]);
        // The fixture maps only the grinning face: everything else is notdef,
        // which carries no bitmap.
        assert!(sbix.resolve_run(&db, &['A'], 64.0).is_none());
        // Behind a covering font the same face loses nothing: the real Noto's
        // hand is drawn even though the sbix face comes first.
        let chain = EmojiFonts::new(vec![
            EmojiSource::Bytes(std::sync::Arc::new(emoji_bitmap_test_font::sbix_bytes())),
            EmojiSource::Bytes(bundled_bytes("fonts/Noto-COLRv1.ttf")),
        ]);
        let hand: Vec<char> = "🫵".chars().collect();
        let glyphs = chain.resolve_run(&db, &hand, 64.0).expect("the next source covers it");
        assert_eq!((glyphs[0].source, glyphs[0].bitmap_ppem), (1, None));
    }
}

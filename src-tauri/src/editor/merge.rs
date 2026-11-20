//! "Merge selected layers" (SPEC §6): composite raster layers, each placed
//! by its transform exactly as the Konva view draws it (translate, then
//! rotate, then scale, about the layer's top-left), into one layer covering
//! their union. Text layers arrive as text, not pixels: each is rasterised
//! from its outlines at its transform (text.rs) and composited like the rest.

use fontdb::Database;
use serde::Deserialize;
use tiny_skia::{ColorU8, FilterQuality, IntSize, Pixmap, PixmapPaint, Point, Transform};

use super::text::{rasterise_placed, TextSpec};
use super::Rgba;

/// Largest side a merged layer may have (guards runaway scales).
pub const MAX_MERGE_SIDE: u32 = 8192;

/// A layer's transform; mirrors `Transform` in src/editor/model/document.ts.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerTransform {
    pub x: f32,
    pub y: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    /// Degrees, clockwise (Konva's convention).
    pub rotation: f32,
}

impl LayerTransform {
    pub const IDENTITY: LayerTransform = LayerTransform { x: 0.0, y: 0.0, scale_x: 1.0, scale_y: 1.0, rotation: 0.0 };
}

/// One merge input: pixels plus where they sit in the document.
#[derive(Debug, Clone)]
pub struct MergeInput {
    pub image: Rgba,
    pub transform: LayerTransform,
}

/// Per-layer metadata sent alongside the concatenated pixel body.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerMeta {
    /// Raster layers: the pixel size. Text layers: their box at scale 1
    /// (informational; the box is laid out again from `text`).
    pub width: u32,
    pub height: u32,
    pub transform: LayerTransform,
    /// Set for a text layer, which has no bytes in the body.
    #[serde(default)]
    pub text: Option<TextSpec>,
}

/// A merge result: an image whose top-left sits at (`x`, `y`) in the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacedImage {
    pub x: i32,
    pub y: i32,
    pub image: Rgba,
}

impl PlacedImage {
    /// Binary IPC frame: i32 LE x, i32 LE y, then `Rgba::to_frame`.
    pub fn to_frame(&self) -> Vec<u8> {
        let mut frame = Vec::with_capacity(8);
        frame.extend_from_slice(&self.x.to_le_bytes());
        frame.extend_from_slice(&self.y.to_le_bytes());
        frame.extend_from_slice(&self.image.to_frame());
        frame
    }
}

/// Split the concatenated RGBA body of a merge request into layers, using
/// each raster layer's declared size. The body must be exactly the sum of
/// sizes. Text layers take no bytes: each is rasterised with `fonts` at its
/// transform into the whole pixels it covers, and becomes an aligned
/// (integer-translated) raster input, so compositing copies it exactly.
pub fn split_layers(meta: &[LayerMeta], body: &[u8], fonts: &Database) -> Result<Vec<MergeInput>, String> {
    let mut layers = Vec::with_capacity(meta.len());
    let mut offset = 0usize;
    for m in meta {
        if let Some(text) = &m.text {
            let placed = rasterise_placed(fonts, text, &m.transform)?;
            let transform = LayerTransform { x: placed.x as f32, y: placed.y as f32, ..LayerTransform::IDENTITY };
            layers.push(MergeInput { image: placed.image, transform });
            continue;
        }
        let len = m.width as usize * m.height as usize * 4;
        let end = offset + len;
        let pixels = body
            .get(offset..end)
            .ok_or_else(|| "merge request body is shorter than its layers".to_string())?
            .to_vec();
        layers.push(MergeInput {
            image: Rgba { width: m.width, height: m.height, pixels },
            transform: m.transform,
        });
        offset = end;
    }
    if offset != body.len() {
        return Err("merge request body is longer than its layers".to_string());
    }
    Ok(layers)
}

/// The view's transform: translate, then rotate (degrees), then scale.
pub(super) fn transform_of(p: &LayerTransform) -> Result<Transform, String> {
    let finite = [p.x, p.y, p.scale_x, p.scale_y, p.rotation].iter().all(|v| v.is_finite());
    if !finite {
        return Err("a layer's transform is not a finite number".to_string());
    }
    Ok(Transform::from_translate(p.x, p.y).pre_rotate(p.rotation).pre_scale(p.scale_x, p.scale_y))
}

/// Straight RGBA8 -> tiny-skia's premultiplied pixmap.
pub(super) fn to_pixmap(image: &Rgba) -> Result<Pixmap, String> {
    let expected = image.width as usize * image.height as usize * 4;
    if image.pixels.len() != expected {
        return Err(format!(
            "a {}x{} layer has {} bytes, expected {expected}",
            image.width,
            image.height,
            image.pixels.len()
        ));
    }
    let size = IntSize::from_wh(image.width, image.height)
        .ok_or_else(|| "a layer has no pixels".to_string())?;
    let mut data = Vec::with_capacity(expected);
    for &[r, g, b, a] in image.pixels.as_chunks::<4>().0 {
        let c = ColorU8::from_rgba(r, g, b, a).premultiply();
        data.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
    }
    Pixmap::from_vec(data, size).ok_or_else(|| "cannot build a pixmap for a layer".to_string())
}

/// A layer drawn smaller than 1:1 (e.g. after "Fit to 512x512" on a large
/// image) is first resampled to its drawn size with Lanczos3, then placed
/// with the leftover (near-1) scale. tiny-skia's bilinear filter samples only
/// neighbouring pixels, so shrinking with it aliases; enlarging and rotating
/// stay with tiny-skia, where bilinear is fine.
pub(super) fn shrink_to_drawn_size(layer: &MergeInput) -> Result<MergeInput, String> {
    let t = layer.transform;
    transform_of(&t)?; // reject non-finite transforms before sizing anything
    let (w, h) = (layer.image.width, layer.image.height);
    let shrunk = |side: u32, scale: f32| -> u32 {
        if scale.abs() < 1.0 { ((side as f32 * scale.abs()).round() as u32).max(1) } else { side }
    };
    let (new_w, new_h) = (shrunk(w, t.scale_x), shrunk(h, t.scale_y));
    if (new_w, new_h) == (w, h) {
        return Ok(layer.clone());
    }
    let image = super::resize(layer.image.clone(), (new_w, new_h))?;
    Ok(MergeInput {
        image,
        transform: LayerTransform {
            scale_x: t.scale_x * w as f32 / new_w as f32,
            scale_y: t.scale_y * h as f32 / new_h as f32,
            ..t
        },
    })
}

/// Snap a bound to the nearest whole pixel when float noise is all that
/// separates them (cos 90 degrees is ~-4e-8, not 0), so a rotation by a
/// right angle does not grow the merged layer by a pixel.
fn snap(v: f32) -> f32 {
    if (v - v.round()).abs() < 1e-3 { v.round() } else { v }
}

/// True when drawing needs no resampling (integer translation only), so
/// pixels copy exactly.
pub(super) fn is_pixel_aligned(p: &LayerTransform) -> bool {
    p.scale_x == 1.0 && p.scale_y == 1.0 && p.rotation == 0.0 && p.x.fract() == 0.0 && p.y.fract() == 0.0
}

/// Composite two or more raster layers, bottom to top, source-over, into
/// one image covering the union of their transformed bounds.
pub fn merge(layers: &[MergeInput]) -> Result<PlacedImage, String> {
    if layers.len() < 2 {
        return Err("merging needs at least two layers".to_string());
    }
    render_layers(layers)
}

/// Merge's rendering for any number of layers (one is fine).
pub(super) fn render_layers(layers: &[MergeInput]) -> Result<PlacedImage, String> {
    let placed = place_layers(layers)?;
    if placed.width > MAX_MERGE_SIDE || placed.height > MAX_MERGE_SIDE {
        return Err(format!(
            "the merged layer would be {}x{}, too large (at most {MAX_MERGE_SIDE} per side)",
            placed.width, placed.height
        ));
    }
    let canvas = render_window(&placed, placed.left as i32, placed.top as i32, placed.width, placed.height)?;
    Ok(PlacedImage { x: placed.left as i32, y: placed.top as i32, image: from_pixmap(&canvas) })
}

/// Layers prepared for drawing, with merge's sampling frame: the integer
/// document origin (`left`, `top`) and size of their union's bounds.
pub(super) struct PlacedLayers {
    layers: Vec<(Pixmap, Transform, bool)>,
    pub(super) left: f32,
    pub(super) top: f32,
    pub(super) width: u32,
    pub(super) height: u32,
}

/// Prepare layers (shrink, convert, measure) and fix merge's frame.
pub(super) fn place_layers(layers: &[MergeInput]) -> Result<PlacedLayers, String> {
    let mut prepared = Vec::with_capacity(layers.len());
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for layer in layers {
        let layer = shrink_to_drawn_size(layer)?;
        let transform = transform_of(&layer.transform)?;
        let pixmap = to_pixmap(&layer.image)?;
        let (w, h) = (layer.image.width as f32, layer.image.height as f32);
        let mut corners = [Point::from_xy(0.0, 0.0), Point::from_xy(w, 0.0), Point::from_xy(0.0, h), Point::from_xy(w, h)];
        transform.map_points(&mut corners);
        for c in corners {
            min_x = min_x.min(c.x);
            min_y = min_y.min(c.y);
            max_x = max_x.max(c.x);
            max_y = max_y.max(c.y);
        }
        prepared.push((pixmap, transform, is_pixel_aligned(&layer.transform)));
    }
    let (left, top) = (snap(min_x).floor(), snap(min_y).floor());
    let (width, height) = ((snap(max_x).ceil() - left) as u32, (snap(max_y).ceil() - top) as u32);
    Ok(PlacedLayers { layers: prepared, left, top, width, height })
}

/// Draw the layers, bottom to top, into a pixmap covering the document
/// window with top-left (`win_x`, `win_y`) and the given size. Only a
/// whole-pixel translation distinguishes windows, so a pixel is sampled the
/// same whichever window shows it. Merge's window is its whole bounds
/// (`left`, `top`); crop's is just its clip.
pub(super) fn render_window(placed: &PlacedLayers, win_x: i32, win_y: i32, width: u32, height: u32) -> Result<Pixmap, String> {
    let mut canvas = Pixmap::new(width.max(1), height.max(1))
        .ok_or_else(|| "cannot allocate the rendered layer".to_string())?;
    for (pixmap, transform, aligned) in &placed.layers {
        draw_placed(&mut canvas, pixmap, *transform, *aligned, (win_x as f32, win_y as f32));
    }
    Ok(canvas)
}

/// Draw a layer source-over onto `canvas`, whose top-left sits at `origin`
/// (whole document pixels): the one placement merge and crop share.
pub(super) fn draw_placed(canvas: &mut Pixmap, pixmap: &Pixmap, transform: Transform, aligned: bool, origin: (f32, f32)) {
    let paint = PixmapPaint {
        quality: if aligned { FilterQuality::Nearest } else { FilterQuality::Bilinear },
        ..PixmapPaint::default()
    };
    canvas.draw_pixmap(0, 0, pixmap.as_ref(), &paint, transform.post_translate(-origin.0, -origin.1), None);
}

/// tiny-skia's premultiplied pixmap -> straight RGBA8.
pub(super) fn from_pixmap(canvas: &Pixmap) -> Rgba {
    let mut pixels = Vec::with_capacity(canvas.pixels().len() * 4);
    for px in canvas.pixels() {
        let c = px.demultiply();
        pixels.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
    }
    Rgba { width: canvas.width(), height: canvas.height(), pixels }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, px: [u8; 4]) -> Rgba {
        Rgba { width, height, pixels: px.repeat((width * height) as usize) }
    }

    fn at(image: Rgba, x: f32, y: f32) -> MergeInput {
        MergeInput { image, transform: LayerTransform { x, y, ..LayerTransform::IDENTITY } }
    }

    fn pixel(p: &PlacedImage, doc_x: i32, doc_y: i32) -> [u8; 4] {
        let (lx, ly) = ((doc_x - p.x) as u32, (doc_y - p.y) as u32);
        let i = ((ly * p.image.width + lx) * 4) as usize;
        p.image.pixels[i..i + 4].try_into().unwrap()
    }

    fn close(a: [u8; 4], b: [u8; 4]) -> bool {
        a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 2)
    }

    #[test]
    fn upper_layers_cover_lower_ones_bottom_to_top() {
        let base = solid(4, 4, [0, 0, 255, 255]);
        let top = solid(2, 2, [255, 0, 0, 255]);
        let merged = merge(&[at(base, 0.0, 0.0), at(top, 1.0, 1.0)]).unwrap();
        assert_eq!((merged.x, merged.y, merged.image.width, merged.image.height), (0, 0, 4, 4));
        assert_eq!(pixel(&merged, 0, 0), [0, 0, 255, 255]);
        assert_eq!(pixel(&merged, 1, 1), [255, 0, 0, 255]);
        assert_eq!(pixel(&merged, 2, 2), [255, 0, 0, 255]);
        assert_eq!(pixel(&merged, 3, 3), [0, 0, 255, 255]);
    }

    #[test]
    fn the_result_covers_the_union_including_negative_positions() {
        let a = solid(4, 4, [0, 255, 0, 255]);
        let b = solid(3, 2, [255, 255, 0, 255]);
        let merged = merge(&[at(a, 0.0, 0.0), at(b, -3.0, 5.0)]).unwrap();
        assert_eq!((merged.x, merged.y), (-3, 0));
        assert_eq!((merged.image.width, merged.image.height), (7, 7));
        assert_eq!(pixel(&merged, -3, 5), [255, 255, 0, 255]);
        assert_eq!(pixel(&merged, 0, 0), [0, 255, 0, 255]);
        // Uncovered corners of the union are transparent.
        assert_eq!(pixel(&merged, 3, 6)[3], 0);
    }

    #[test]
    fn translucent_pixels_blend_with_source_over() {
        let blue = solid(2, 2, [0, 0, 255, 255]);
        let half_red = solid(2, 2, [255, 0, 0, 128]);
        let merged = merge(&[at(blue, 0.0, 0.0), at(half_red, 0.0, 0.0)]).unwrap();
        assert!(close(pixel(&merged, 0, 0), [128, 0, 127, 255]), "{:?}", pixel(&merged, 0, 0));
    }

    #[test]
    fn translucent_colour_survives_without_darkening() {
        // Straight alpha in and out: a 50% white over nothing stays white.
        let ghost = solid(2, 2, [255, 255, 255, 128]);
        let empty = solid(2, 2, [0, 0, 0, 0]);
        let merged = merge(&[at(empty, 0.0, 0.0), at(ghost, 0.0, 0.0)]).unwrap();
        assert!(close(pixel(&merged, 1, 1), [255, 255, 255, 128]), "{:?}", pixel(&merged, 1, 1));
    }

    #[test]
    fn scale_and_rotation_place_layers_like_the_view() {
        let base = solid(1, 1, [0, 0, 0, 255]);
        // 2x2 scaled by 2 at (0,0) covers 4x4.
        let scaled = MergeInput {
            image: solid(2, 2, [255, 0, 0, 255]),
            transform: LayerTransform { scale_x: 2.0, scale_y: 2.0, ..LayerTransform::IDENTITY },
        };
        let merged = merge(&[at(base.clone(), 0.0, 0.0), scaled]).unwrap();
        assert_eq!((merged.image.width, merged.image.height), (4, 4));
        assert!(close(pixel(&merged, 3, 3), [255, 0, 0, 255]));
        // 4x2 rotated 90 degrees clockwise about its top-left at (0,0)
        // swings down-left: it covers x in [-2, 0), y in [0, 4).
        let rotated = MergeInput {
            image: solid(4, 2, [0, 255, 0, 255]),
            transform: LayerTransform { rotation: 90.0, ..LayerTransform::IDENTITY },
        };
        let merged = merge(&[at(base, 0.0, 0.0), rotated]).unwrap();
        assert_eq!((merged.x, merged.y), (-2, 0));
        assert_eq!((merged.image.width, merged.image.height), (3, 4));
        assert!(close(pixel(&merged, -1, 2), [0, 255, 0, 255]));
    }

    #[test]
    fn shrunk_layers_are_resampled_smoothly_not_aliased() {
        // One white column in every three (true average ~85) shrunk to a
        // third, as after "Fit to 512x512" on a large image. Bilinear
        // sampling lands between two black columns and returns black;
        // area-aware resampling returns the average grey.
        let (w, h) = (600u32, 60u32);
        let mut pixels = Vec::with_capacity((w * h * 4) as usize);
        for _y in 0..h {
            for x in 0..w {
                let v = if x % 3 == 0 { 255 } else { 0 };
                pixels.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let third = 1.0 / 3.0;
        let stripes = MergeInput {
            image: Rgba { width: w, height: h, pixels },
            transform: LayerTransform { scale_x: third, scale_y: third, ..LayerTransform::IDENTITY },
        };
        let empty = at(solid(1, 1, [0, 0, 0, 0]), 0.0, 0.0);
        let merged = merge(&[empty, stripes]).unwrap();
        assert_eq!((merged.image.width, merged.image.height), (200, 20));
        for y in 3..17 {
            for x in 3..197 {
                let [r, _, _, a] = pixel(&merged, x, y);
                assert_eq!(a, 255);
                assert!((60..=110).contains(&r), "aliased at ({x},{y}): {r}");
            }
        }
    }

    #[test]
    fn merging_needs_two_valid_layers_of_bounded_size() {
        let one = at(solid(2, 2, [0, 0, 0, 255]), 0.0, 0.0);
        assert!(merge(std::slice::from_ref(&one)).is_err());
        let huge = MergeInput {
            image: solid(2, 2, [0, 0, 0, 255]),
            transform: LayerTransform { scale_x: 10_000.0, scale_y: 1.0, ..LayerTransform::IDENTITY },
        };
        assert!(merge(&[one.clone(), huge]).unwrap_err().contains("too large"));
        let broken = MergeInput {
            image: Rgba { width: 2, height: 2, pixels: vec![0; 3] },
            transform: LayerTransform::IDENTITY,
        };
        assert!(merge(&[one.clone(), broken]).is_err());
        let nan = MergeInput {
            image: solid(1, 1, [0, 0, 0, 255]),
            transform: LayerTransform { x: f32::NAN, ..LayerTransform::IDENTITY },
        };
        assert!(merge(&[one, nan]).is_err());
    }

    #[test]
    fn the_wire_body_splits_into_layers_by_their_sizes() {
        let fonts = Database::new();
        let meta = [
            LayerMeta { width: 1, height: 1, transform: LayerTransform::IDENTITY, text: None },
            LayerMeta { width: 2, height: 1, transform: LayerTransform { x: 5.0, ..LayerTransform::IDENTITY }, text: None },
        ];
        let body: Vec<u8> = (0..12).collect();
        let layers = split_layers(&meta, &body, &fonts).unwrap();
        assert_eq!(layers[0].image.pixels, vec![0, 1, 2, 3]);
        assert_eq!(layers[1].image.pixels, (4..12).collect::<Vec<u8>>());
        assert_eq!(layers[1].transform.x, 5.0);
        assert!(split_layers(&meta, &body[..11], &fonts).is_err());
        assert!(split_layers(&meta, &[body.clone(), vec![0]].concat(), &fonts).is_err());
    }

    #[test]
    fn text_layers_take_no_bytes_and_merge_as_their_glyphs() {
        // A white 100x100 base, then "A" in red at 100 px placed at (10, 0):
        // its glyph inks x 20..60, y 10..80 (see text.rs).
        let fonts = super::super::test_font::database();
        let meta: Vec<LayerMeta> = serde_json::from_str(&format!(
            r##"[{{"width":100,"height":100,"transform":{{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0}}}},
                {{"width":60,"height":100,"transform":{{"x":10,"y":0,"scaleX":1,"scaleY":1,"rotation":0}},
                  "text":{{"text":"A","fontFamily":"{}","fontSize":100,"color":"#ff0000"}}}}]"##,
            super::super::test_font::FAMILY
        ))
        .unwrap();
        let body = [255u8; 100 * 100 * 4];
        let layers = split_layers(&meta, &body, &fonts).unwrap();
        assert_eq!((layers[1].image.width, layers[1].image.height), (60, 100));
        let merged = merge(&layers).unwrap();
        assert_eq!((merged.x, merged.y, merged.image.width, merged.image.height), (0, 0, 100, 100));
        assert_eq!(pixel(&merged, 20, 10), [255, 0, 0, 255]);
        assert_eq!(pixel(&merged, 59, 79), [255, 0, 0, 255]);
        assert_eq!(pixel(&merged, 19, 10), [255, 255, 255, 255]);
        assert_eq!(pixel(&merged, 60, 50), [255, 255, 255, 255]);
        // A text layer whose font is missing is refused, not skipped.
        assert!(split_layers(&meta, &body, &Database::new()).unwrap_err().contains("not installed"));
    }

    #[test]
    fn placed_frame_prefixes_the_signed_origin() {
        let p = PlacedImage { x: -2, y: 3, image: Rgba { width: 1, height: 1, pixels: vec![9, 9, 9, 9] } };
        let frame = p.to_frame();
        assert_eq!(&frame[..8], &[0xFE, 0xFF, 0xFF, 0xFF, 3, 0, 0, 0]);
        assert_eq!(&frame[8..16], &[1, 0, 0, 0, 1, 0, 0, 0]);
    }

    #[test]
    fn transform_json_matches_the_typescript_field_names() {
        let t: LayerTransform =
            serde_json::from_str(r#"{"x":1,"y":2,"scaleX":3,"scaleY":4,"rotation":5}"#).unwrap();
        assert_eq!(t, LayerTransform { x: 1.0, y: 2.0, scale_x: 3.0, scale_y: 4.0, rotation: 5.0 });
    }
}

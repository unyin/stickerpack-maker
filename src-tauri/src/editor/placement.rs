//! Placement (SPEC §6): the neutral layer vocabulary merge, crop, cut and
//! text share. A layer is pixels plus a transform, placed exactly as the
//! Konva view draws it (translate, then rotate, then scale, about the
//! layer's top-left). This module measures placed layers, snaps their
//! bounds to whole pixels and draws them source-over into a window of the
//! document; it knows nothing of text, wire formats or any one operation.
//! Dependencies run one way: placement <- text <- layers <- merge/crop/cut.

use serde::Deserialize;
use tiny_skia::{ColorU8, FilterQuality, IntSize, Pixmap, PixmapPaint, Point, Transform};

use super::Rgba;

/// Largest side a placed, merged or cropped layer may have (guards runaway scales).
pub const MAX_LAYER_SIDE: u32 = 8192;

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

/// One layer as pixels plus where they sit in the document.
#[derive(Debug, Clone)]
pub struct LayerInput {
    pub image: Rgba,
    pub transform: LayerTransform,
}

/// An image whose top-left sits at (`x`, `y`) in the document.
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

/// The view's transform: translate, then rotate (degrees), then scale.
pub(super) fn transform_of(p: &LayerTransform) -> Result<Transform, String> {
    let finite = [p.x, p.y, p.scale_x, p.scale_y, p.rotation].iter().all(|v| v.is_finite());
    if !finite {
        return Err("a layer's transform is not a finite number".to_string());
    }
    Ok(Transform::from_translate(p.x, p.y).pre_rotate(p.rotation).pre_scale(p.scale_x, p.scale_y))
}

/// Refuse a `what` (e.g. "merged layer") drawn wider or taller than `MAX_LAYER_SIDE`.
pub(super) fn check_extent(width: u32, height: u32, what: &str) -> Result<(), String> {
    if width > MAX_LAYER_SIDE || height > MAX_LAYER_SIDE {
        return Err(format!("the {what} would be {width}x{height}, too large (at most {MAX_LAYER_SIDE} per side)"));
    }
    Ok(())
}

/// Refuse a document window for `what` (e.g. "crop") with no pixels or too many.
pub(super) fn check_window(width: u32, height: u32, what: &str) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err(format!("the {what} window has no pixels"));
    }
    if width > MAX_LAYER_SIDE || height > MAX_LAYER_SIDE {
        return Err(format!("the {what} window is {width}x{height}, too large (at most {MAX_LAYER_SIDE} per side)"));
    }
    Ok(())
}

/// Snap a bound to the nearest whole pixel when float noise is all that
/// separates them (cos 90 degrees is ~-4e-8, not 0), so a rotation by a
/// right angle does not grow a layer by a pixel.
fn snap(v: f32) -> f32 {
    if (v - v.round()).abs() < 1e-3 { v.round() } else { v }
}

/// An axis-aligned box in document pixels, grown by placed layers.
#[derive(Debug, Clone, Copy)]
pub(super) struct Bounds {
    min_x: f32,
    min_y: f32,
    max_x: f32,
    max_y: f32,
}

impl Bounds {
    pub(super) const EMPTY: Bounds = Bounds { min_x: f32::MAX, min_y: f32::MAX, max_x: f32::MIN, max_y: f32::MIN };

    /// The box of a `width` x `height` image placed by `transform`.
    pub(super) fn of(transform: &Transform, width: u32, height: u32) -> Bounds {
        let (w, h) = (width as f32, height as f32);
        let mut corners = [Point::from_xy(0.0, 0.0), Point::from_xy(w, 0.0), Point::from_xy(0.0, h), Point::from_xy(w, h)];
        transform.map_points(&mut corners);
        corners.iter().fold(Bounds::EMPTY, |b, c| Bounds {
            min_x: b.min_x.min(c.x),
            min_y: b.min_y.min(c.y),
            max_x: b.max_x.max(c.x),
            max_y: b.max_y.max(c.y),
        })
    }

    pub(super) fn union(self, o: Bounds) -> Bounds {
        Bounds {
            min_x: self.min_x.min(o.min_x),
            min_y: self.min_y.min(o.min_y),
            max_x: self.max_x.max(o.max_x),
            max_y: self.max_y.max(o.max_y),
        }
    }

    /// The whole pixels covered: integer origin (`left`, `top`) and size.
    pub(super) fn whole_pixels(self) -> (f32, f32, u32, u32) {
        let (left, top) = (snap(self.min_x).floor(), snap(self.min_y).floor());
        (left, top, (snap(self.max_x).ceil() - left) as u32, (snap(self.max_y).ceil() - top) as u32)
    }
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

/// tiny-skia's premultiplied pixmap -> straight RGBA8.
pub(super) fn from_pixmap(canvas: &Pixmap) -> Rgba {
    let mut pixels = Vec::with_capacity(canvas.pixels().len() * 4);
    for px in canvas.pixels() {
        let c = px.demultiply();
        pixels.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
    }
    Rgba { width: canvas.width(), height: canvas.height(), pixels }
}

/// A layer drawn smaller than 1:1 (e.g. after "Fit to 512x512" on a large
/// image) is first resampled to its drawn size with Lanczos3, then placed
/// with the leftover (near-1) scale. tiny-skia's bilinear filter samples only
/// neighbouring pixels, so shrinking with it aliases; enlarging and rotating
/// stay with tiny-skia, where bilinear is fine.
fn shrink_to_drawn_size(layer: &LayerInput) -> Result<LayerInput, String> {
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
    Ok(LayerInput {
        image,
        transform: LayerTransform {
            scale_x: t.scale_x * w as f32 / new_w as f32,
            scale_y: t.scale_y * h as f32 / new_h as f32,
            ..t
        },
    })
}

/// True when drawing needs no resampling (integer translation only), so
/// pixels copy exactly.
fn is_pixel_aligned(p: &LayerTransform) -> bool {
    p.scale_x == 1.0 && p.scale_y == 1.0 && p.rotation == 0.0 && p.x.fract() == 0.0 && p.y.fract() == 0.0
}

/// Layers prepared for drawing, with the sampling frame: the integer
/// document origin (`left`, `top`) and size of their union's bounds.
pub(super) struct PlacedLayers {
    layers: Vec<(Pixmap, Transform, bool)>,
    pub(super) left: f32,
    pub(super) top: f32,
    pub(super) width: u32,
    pub(super) height: u32,
}

/// Prepare layers (shrink, convert, measure) and fix the sampling frame.
pub(super) fn place_layers(layers: &[LayerInput]) -> Result<PlacedLayers, String> {
    let mut prepared = Vec::with_capacity(layers.len());
    let mut bounds = Bounds::EMPTY;
    for layer in layers {
        let layer = shrink_to_drawn_size(layer)?;
        let transform = transform_of(&layer.transform)?;
        let pixmap = to_pixmap(&layer.image)?;
        bounds = bounds.union(Bounds::of(&transform, layer.image.width, layer.image.height));
        prepared.push((pixmap, transform, is_pixel_aligned(&layer.transform)));
    }
    let (left, top, width, height) = bounds.whole_pixels();
    Ok(PlacedLayers { layers: prepared, left, top, width, height })
}

/// Draw the layers, bottom to top, into a pixmap covering the document
/// window with top-left (`win_x`, `win_y`) and the given size. Only a
/// whole-pixel translation distinguishes windows, so a pixel is sampled the
/// same whichever window shows it. Merge's window is the whole bounds
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
/// (whole document pixels).
fn draw_placed(canvas: &mut Pixmap, pixmap: &Pixmap, transform: Transform, aligned: bool, origin: (f32, f32)) {
    let paint = PixmapPaint {
        quality: if aligned { FilterQuality::Nearest } else { FilterQuality::Bilinear },
        ..PixmapPaint::default()
    };
    canvas.draw_pixmap(0, 0, pixmap.as_ref(), &paint, transform.post_translate(-origin.0, -origin.1), None);
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn a_right_angle_rotation_does_not_grow_the_bounds_by_a_pixel() {
        let t = transform_of(&LayerTransform { rotation: 90.0, ..LayerTransform::IDENTITY }).unwrap();
        let (left, top, width, height) = Bounds::of(&t, 4, 2).whole_pixels();
        assert_eq!((left, top, width, height), (-2.0, 0.0, 2, 4));
    }

    #[test]
    fn extents_and_windows_are_capped() {
        assert!(check_extent(MAX_LAYER_SIDE, 1, "thing").is_ok());
        assert!(check_extent(1, MAX_LAYER_SIDE + 1, "thing").unwrap_err().contains("the thing would be"));
        assert!(check_window(0, 1, "thing").is_err());
        assert!(check_window(MAX_LAYER_SIDE + 1, 1, "thing").unwrap_err().contains("too large"));
        assert!(check_window(3, 3, "thing").is_ok());
    }
}

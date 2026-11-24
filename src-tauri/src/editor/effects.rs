//! Outline and fuzzy glow (SPEC §6, SPM-8): one-shot pixel work on one
//! layer (ADR-0005). The same code draws the live preview and the result
//! Apply bakes in (owner decision 2026-11-22, ADR-0008), so they match.
//!
//! Both effects grow a mask out of the layer's alpha silhouette and draw it
//! in a colour BEHIND the layer's own pixels (normal blending only, owner
//! decision 2026-11-21), so every opaque pixel of the layer is unchanged:
//! - **Outline** (colour, width): the silhouette grown by `width` px, with
//!   an anti-aliased edge. Growth uses imageproc's Euclidean distance
//!   transform, so corners round off as a real outline does.
//! - **Fuzzy glow** (colour, radius, softness, opacity): the silhouette
//!   grown by the hard part of the radius, `radius * (1 - softness)`, then
//!   blurred over the rest: three box blurs (imageproc), a close Gaussian
//!   approximation (ADR-0005's "Gaussian blur") whose reach is exactly
//!   finite, so the layer grows by exactly that reach and the glow is never
//!   clipped. The blur radius is rounded to whole pixels (at least one when
//!   there is any softness), so the reach can differ from the set radius by
//!   up to about a pixel and a half, except that a glow with under ~1.5 px
//!   of softness still blurs by one pixel per pass (3 px in all).
//!
//! Sizes are in document px (what the user sees); a scaled layer gets them
//! in its own pixels (divided by its scale), so the effect looks the same at
//! any layer scale. The result is larger than the layer by the effect's
//! reach on every side, with a new top-left (CMT-142), as merge's placed
//! image is; the layer keeps its rotation and scale.

use image::GrayImage;
use imageproc::distance_transform::euclidean_squared_distance_transform;
use imageproc::filter::box_filter;
use serde::Deserialize;
use tiny_skia::Point;

use super::layers::{aligned_input, decode_layer, finish_body, LayerMeta};
use super::placement::{check_extent, transform_of, LayerInput, LayerTransform};
use super::text::{parse_color, rasterise_placed};
use super::Rgba;

/// An effect and its settings, as the Editor's effect tools send them.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Effect {
    /// A solid line around the silhouette, `width` document px wide.
    Outline { color: String, width: f32 },
    /// A soft glow reaching `radius` document px out; `softness` and
    /// `opacity` are fractions from 0 to 1 (softness 0 is a hard edge, 1 a
    /// glow that fades over the whole radius).
    Glow { color: String, radius: f32, softness: f32, opacity: f32 },
}

/// Metadata of an effect request: the target layer (as for merge: a raster
/// layer's size and transform, or a text layer's text) and the effect.
#[derive(Debug, Clone, Deserialize)]
pub struct EffectMeta {
    #[serde(flatten)]
    pub layer: LayerMeta,
    pub effect: Effect,
}

impl EffectMeta {
    /// The target layer from the request body. A text layer takes no bytes:
    /// it is rasterised in Rust at its transform (sharp at any scale), as an
    /// unscaled image placed on whole document pixels.
    pub fn decode_layer(
        &self,
        body: &[u8],
        fonts: &fontdb::Database,
        emoji: &super::emoji::EmojiFonts,
    ) -> Result<LayerInput, String> {
        let mut rest = body;
        let layer = decode_layer(&self.layer, &mut rest, |spec, t| {
            aligned_input(rasterise_placed(fonts, emoji, spec, t)?)
        })?;
        finish_body(rest)?;
        Ok(layer)
    }
}

/// What an effect produces: the layer's new pixels and where they go.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectResult {
    /// The new layer's transform: the input's rotation and scale, with the
    /// top-left moved out by the effect's reach.
    pub transform: LayerTransform,
    pub image: Rgba,
}

impl EffectResult {
    /// Binary IPC frame: the transform as five f32 LE (x, y, scaleX, scaleY,
    /// rotation), then `Rgba::to_frame`.
    pub fn to_frame(&self) -> Vec<u8> {
        let t = self.transform;
        let mut frame = Vec::with_capacity(20 + 8 + self.image.pixels.len());
        for v in [t.x, t.y, t.scale_x, t.scale_y, t.rotation] {
            frame.extend_from_slice(&v.to_le_bytes());
        }
        frame.extend_from_slice(&self.image.to_frame());
        frame
    }
}

/// Alpha at or above this counts as inside the silhouette the outline grows from.
const SILHOUETTE_ALPHA: u8 = 128;

/// Box blurs stacked for the glow: three come within a few percent of a Gaussian.
const BLUR_PASSES: u32 = 3;

/// A `0..=1` fraction setting, or an error naming it.
fn fraction(value: f32, what: &str) -> Result<f32, String> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(value)
    } else {
        Err(format!("the glow {what} must be from 0 to 1"))
    }
}

/// A size in document px as layer px: divided by the layer's (uniform) scale.
fn layer_px(size: f32, transform: &LayerTransform, what: &str) -> Result<f32, String> {
    if !(size.is_finite() && size > 0.0) {
        return Err(format!("the {what} must be more than 0 px"));
    }
    let scale = (transform.scale_x * transform.scale_y).abs().sqrt();
    if !(scale.is_finite() && scale > 0.0) {
        return Err("the layer is scaled to nothing, so no effect can be drawn on it".to_string());
    }
    Ok(size / scale)
}

/// Apply `effect` to `layer` (its pixels in its own grid, placed by its transform).
pub fn apply(layer: &LayerInput, effect: &Effect) -> Result<EffectResult, String> {
    let image = &layer.image;
    if image.pixels.len() != image.width as usize * image.height as usize * 4 || image.width == 0 || image.height == 0 {
        return Err("the layer's pixels do not match its size".to_string());
    }
    let t = &layer.transform;
    let placed = transform_of(t)?; // also rejects non-finite transforms
    // What differs between the effects: the colour, the hard spread around
    // the silhouette, the box blur radius after it, and the opacity.
    let (color, spread, blur, opacity) = match effect {
        Effect::Outline { color, width } => (color, layer_px(*width, t, "outline width")?, 0, 1.0),
        Effect::Glow { color, radius, softness, opacity } => {
            let radius = layer_px(*radius, t, "glow radius")?;
            let (softness, opacity) = (fraction(*softness, "softness")?, fraction(*opacity, "opacity")?);
            let spread = radius * (1.0 - softness);
            // The passes together roughly fill the radius left over by the
            // spread (rounded to whole pixels; see the module doc); any
            // softness blurs by at least one pixel, so a small soft glow still shows.
            let soft = radius - spread;
            let blur = if soft > 0.0 { ((soft / BLUR_PASSES as f32).round() as u32).max(1) } else { 0 };
            (color, spread, blur, opacity)
        }
    };
    let color = parse_color(color)?;
    // The effect's exact reach: the spread (its anti-aliased edge ends
    // within ceil(spread)) plus each blur pass's radius.
    let pad = spread.ceil() as u32 + BLUR_PASSES * blur;
    let (w, h) = (image.width + 2 * pad, image.height + 2 * pad);
    check_extent(w, h, "layer with the effect")?;
    let mut pixels = grown(image, pad);
    let mut mask = grown_mask(&pixels, w, h, spread);
    if blur > 0 {
        for _ in 0..BLUR_PASSES {
            mask = box_filter(&mask, blur, blur);
        }
    }
    draw_behind(&mut pixels, &mask, color, opacity);
    let mut origin = [Point::from_xy(-(pad as f32), -(pad as f32))];
    placed.map_points(&mut origin);
    Ok(EffectResult {
        transform: LayerTransform { x: origin[0].x, y: origin[0].y, ..*t },
        image: Rgba { width: w, height: h, pixels },
    })
}

/// The layer's pixels on a transparent canvas grown by `pad` px each side.
fn grown(image: &Rgba, pad: u32) -> Vec<u8> {
    let (w, h) = ((image.width + 2 * pad) as usize, (image.height + 2 * pad) as usize);
    let (row, pad) = (image.width as usize * 4, pad as usize);
    let mut out = vec![0u8; w * h * 4];
    for (y, src) in image.pixels.chunks_exact(row).enumerate() {
        let start = ((y + pad) * w + pad) * 4;
        out[start..start + row].copy_from_slice(src);
    }
    out
}

/// The alpha of `pixels` (a `w` x `h` RGBA canvas), plus every pixel within
/// `spread` px of its silhouette, anti-aliased over one pixel. A pixel's
/// distance is from its centre to the nearest silhouette pixel's centre;
/// the silhouette's edge lies half a pixel out from those centres.
fn grown_mask(pixels: &[u8], w: u32, h: u32, spread: f32) -> GrayImage {
    let alpha: Vec<u8> = pixels.as_chunks::<4>().0.iter().map(|p| p[3]).collect();
    let mut mask = GrayImage::from_raw(w, h, alpha).expect("one alpha byte per pixel");
    if spread <= 0.0 {
        return mask;
    }
    let silhouette: Vec<u8> = mask.as_raw().iter().map(|&a| u8::from(a >= SILHOUETTE_ALPHA)).collect();
    let silhouette = GrayImage::from_raw(w, h, silhouette).expect("one byte per pixel");
    let distances = euclidean_squared_distance_transform(&silhouette);
    let reach = f64::from(spread) + 1.0;
    for (m, d2) in mask.iter_mut().zip(distances.as_raw()) {
        // Full inside `spread` of the edge, fading to nothing one pixel further.
        if *m < 255 && *d2 < reach * reach {
            let cover = (reach - d2.sqrt()).clamp(0.0, 1.0);
            *m = (*m).max((cover * 255.0).round() as u8);
        }
    }
    mask
}

/// Draw `pixels` (straight RGBA) over `color` at `mask` alpha times
/// `opacity`, in place: source-over, so opaque pixels stay exact.
fn draw_behind(pixels: &mut [u8], mask: &GrayImage, color: [u8; 3], opacity: f32) {
    for (p, &m) in pixels.as_chunks_mut::<4>().0.iter_mut().zip(mask.as_raw()) {
        if p[3] == 255 || m == 0 {
            continue;
        }
        let sa = f32::from(p[3]) / 255.0;
        let ea = f32::from(m) / 255.0 * opacity * (1.0 - sa);
        let a = sa + ea;
        if a <= 0.0 {
            continue;
        }
        for (c, e) in p[..3].iter_mut().zip(color) {
            *c = ((f32::from(*c) * sa + f32::from(e) * ea) / a).round() as u8;
        }
        p[3] = (a * 255.0).round() as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::emoji::EmojiFonts;

    /// A `size` x `size` transparent image with an opaque `[r, g, b]` square
    /// covering pixels `from..to` on both axes.
    fn square(size: u32, from: u32, to: u32, rgb: [u8; 3]) -> Rgba {
        let mut pixels = vec![0u8; (size * size * 4) as usize];
        for y in from..to {
            for x in from..to {
                let i = ((y * size + x) * 4) as usize;
                pixels[i..i + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            }
        }
        Rgba { width: size, height: size, pixels }
    }

    fn px(image: &Rgba, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width + x) * 4) as usize;
        image.pixels[i..i + 4].try_into().unwrap()
    }

    fn layer(image: Rgba, transform: LayerTransform) -> LayerInput {
        LayerInput { image, transform }
    }

    fn outline(color: &str, width: f32) -> Effect {
        Effect::Outline { color: color.to_string(), width }
    }

    fn glow(radius: f32, softness: f32, opacity: f32) -> Effect {
        Effect::Glow { color: "#00ff00".to_string(), radius, softness, opacity }
    }

    #[test]
    fn an_outline_grows_the_layer_by_its_width_and_moves_its_top_left() {
        let source = layer(square(10, 3, 7, [255, 0, 0]), LayerTransform { x: 20.0, y: 30.0, ..LayerTransform::IDENTITY });
        let out = apply(&source, &outline("#ffffff", 2.0)).unwrap();
        assert_eq!((out.image.width, out.image.height), (14, 14));
        assert_eq!((out.transform.x, out.transform.y), (18.0, 28.0));
        // The square now sits at 5..9 in the grown grid: unchanged pixels.
        assert_eq!(px(&out.image, 5, 5), [255, 0, 0, 255]);
        assert_eq!(px(&out.image, 8, 8), [255, 0, 0, 255]);
        // Two pixels out on each axis: white, then nothing.
        assert_eq!(px(&out.image, 3, 6), [255, 255, 255, 255]);
        assert_eq!(px(&out.image, 4, 6), [255, 255, 255, 255]);
        assert_eq!(px(&out.image, 2, 6)[3], 0);
        assert_eq!(px(&out.image, 11, 6)[3], 0);
        assert_eq!(px(&out.image, 10, 6), [255, 255, 255, 255]);
    }

    #[test]
    fn outline_corners_are_round_and_anti_aliased() {
        let out = apply(&layer(square(10, 3, 7, [0, 0, 0]), LayerTransform::IDENTITY), &outline("#ffffff", 3.0)).unwrap();
        // Square at 6..10 in a 16 px grid. The pixel diagonally 4 px off the
        // corner is ~5.7 px from it: outside a round 3 px outline.
        assert_eq!(px(&out.image, 2, 2)[3], 0);
        // 2 px diagonally off the corner (~2.8 px) is inside, fully or partly.
        assert!(px(&out.image, 4, 4)[3] > 0);
        let partly = (0..16).flat_map(|y| (0..16).map(move |x| (x, y))).any(|(x, y)| {
            let a = px(&out.image, x, y)[3];
            a > 0 && a < 255
        });
        assert!(partly, "the outline's edge is anti-aliased");
    }

    #[test]
    fn soft_layer_edges_keep_their_colour_over_the_outline() {
        // A half-transparent red pixel next to the square: the outline shows through it.
        let mut image = square(8, 2, 6, [255, 0, 0]);
        let i = ((3 * 8 + 6) * 4) as usize;
        image.pixels[i..i + 4].copy_from_slice(&[255, 0, 0, 128]);
        let out = apply(&layer(image, LayerTransform::IDENTITY), &outline("#0000ff", 2.0)).unwrap();
        let p = px(&out.image, 8, 5);
        assert_eq!(p[3], 255);
        assert!(p[0] > 100 && p[2] > 100, "red over blue: {p:?}");
    }

    #[test]
    fn a_scaled_layer_gets_the_width_in_its_own_pixels_and_keeps_its_transform() {
        // Drawn at scale 2: a 4 document px outline is 2 layer px.
        let t = LayerTransform { x: 10.0, y: 10.0, scale_x: 2.0, scale_y: 2.0, rotation: 0.0 };
        let out = apply(&layer(square(10, 3, 7, [0, 0, 0]), t), &outline("#ffffff", 4.0)).unwrap();
        assert_eq!((out.image.width, out.image.height), (14, 14));
        assert_eq!((out.transform.x, out.transform.y), (6.0, 6.0));
        assert_eq!((out.transform.scale_x, out.transform.rotation), (2.0, 0.0));
        // Rotated 90 degrees: the grid's (-pad, -pad) is drawn at (x + pad, y - pad).
        let t = LayerTransform { x: 10.0, y: 10.0, rotation: 90.0, ..LayerTransform::IDENTITY };
        let out = apply(&layer(square(10, 3, 7, [0, 0, 0]), t), &outline("#ffffff", 2.0)).unwrap();
        assert!((out.transform.x - 12.0).abs() < 1e-4 && (out.transform.y - 8.0).abs() < 1e-4, "{:?}", out.transform);
        assert_eq!(out.transform.rotation, 90.0);
    }

    #[test]
    fn a_glow_fades_out_and_ends_inside_its_radius() {
        let out = apply(&layer(square(20, 4, 16, [255, 0, 0]), LayerTransform::IDENTITY), &glow(9.0, 1.0, 1.0)).unwrap();
        assert_eq!((out.image.width, out.image.height), (38, 38));
        // The square sits at 13..25; the row through its middle fades outwards.
        let row: Vec<u8> = (0..13).map(|x| px(&out.image, x, 19)[3]).collect();
        assert_eq!(row[0], 0, "nothing reaches the new border: {row:?}");
        assert!(row.windows(2).all(|w| w[0] <= w[1]), "fades outwards: {row:?}");
        assert!(row[12] > 64 && row[12] < 255, "soft next to the layer: {row:?}");
        assert_eq!(px(&out.image, 13, 13), [255, 0, 0, 255], "the layer's own pixels stay");
        let green = px(&out.image, 11, 19);
        assert_eq!((green[0], green[1]), (0, 255));
    }

    #[test]
    fn a_small_soft_glow_still_shows() {
        let out = apply(&layer(square(10, 3, 7, [255, 0, 0]), LayerTransform::IDENTITY), &glow(2.0, 1.0, 1.0)).unwrap();
        assert_eq!(out.image.width, 16, "one blur pass radius 1, three passes");
        assert!(px(&out.image, 4, 8)[3] > 0, "the glow reaches past the edge");
    }

    #[test]
    fn glow_softness_zero_is_a_hard_spread_and_opacity_scales_it() {
        let hard = apply(&layer(square(10, 3, 7, [255, 0, 0]), LayerTransform::IDENTITY), &glow(3.0, 0.0, 0.5)).unwrap();
        // A 3 px spread at half opacity: (4, 8) is 2 px left of the square at 6..10.
        assert_eq!(px(&hard.image, 4, 8)[3], 128);
        assert_eq!(px(&hard.image, 2, 8)[3], 0);
        let none = apply(&layer(square(10, 3, 7, [255, 0, 0]), LayerTransform::IDENTITY), &glow(3.0, 0.5, 0.0)).unwrap();
        let square_at = (none.image.width - 4) / 2; // the 4 px square stays centred
        assert!((0..none.image.width)
            .all(|x| px(&none.image, x, square_at + 1)[3] == if (square_at..square_at + 4).contains(&x) { 255 } else { 0 }));
    }

    #[test]
    fn bad_settings_and_oversized_results_are_refused() {
        let source = layer(square(4, 1, 3, [0, 0, 0]), LayerTransform::IDENTITY);
        assert!(apply(&source, &outline("white", 2.0)).is_err());
        assert!(apply(&source, &outline("#ffffff", 0.0)).is_err());
        assert!(apply(&source, &outline("#ffffff", f32::NAN)).is_err());
        assert!(apply(&source, &glow(5.0, 1.5, 1.0)).is_err());
        assert!(apply(&source, &glow(5.0, 0.5, -0.1)).is_err());
        assert!(apply(&source, &outline("#ffffff", 5000.0)).unwrap_err().contains("too large"));
        let flat = layer(square(4, 1, 3, [0, 0, 0]), LayerTransform { scale_x: 0.0, ..LayerTransform::IDENTITY });
        assert!(apply(&flat, &outline("#ffffff", 2.0)).is_err());
    }

    #[test]
    fn the_frame_is_the_transform_then_the_image() {
        let result = EffectResult {
            transform: LayerTransform { x: -2.0, y: 1.5, scale_x: 1.0, scale_y: 1.0, rotation: 0.0 },
            image: Rgba { width: 1, height: 1, pixels: vec![1, 2, 3, 4] },
        };
        let frame = result.to_frame();
        assert_eq!(&frame[0..4], &(-2.0f32).to_le_bytes());
        assert_eq!(&frame[4..8], &1.5f32.to_le_bytes());
        assert_eq!(&frame[20..], &[1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 4]);
    }

    #[test]
    fn meta_json_carries_the_layer_and_the_effect() {
        let meta: EffectMeta = serde_json::from_str(
            r##"{"width":2,"height":1,"transform":{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0},
                "effect":{"kind":"glow","color":"#ff0000","radius":12,"softness":0.5,"opacity":0.8}}"##,
        )
        .unwrap();
        assert_eq!(meta.effect, Effect::Glow { color: "#ff0000".into(), radius: 12.0, softness: 0.5, opacity: 0.8 });
        let layer = meta.decode_layer(&[0; 8], &fontdb::Database::new(), &EmojiFonts::empty()).unwrap();
        assert_eq!((layer.image.width, layer.image.height), (2, 1));
        assert!(meta.decode_layer(&[0; 7], &fontdb::Database::new(), &EmojiFonts::empty()).is_err());
    }

    #[test]
    fn a_text_layer_is_rasterised_at_its_transform_and_placed_unscaled() {
        // "A" at 100 px placed at (10, 0) at scale 2: Rust draws it sharp,
        // so the result is unscaled, on whole document pixels.
        let fonts = super::super::test_font::database();
        let meta: EffectMeta = serde_json::from_str(&format!(
            r##"{{"width":60,"height":100,"transform":{{"x":10,"y":0,"scaleX":2,"scaleY":2,"rotation":0}},
                "text":{{"text":"A","fontFamily":"{}","fontSize":100,"color":"#ff0000"}},
                "effect":{{"kind":"outline","color":"#000000","width":3}}}}"##,
            super::super::test_font::FAMILY
        ))
        .unwrap();
        let layer = meta.decode_layer(&[], &fonts, &EmojiFonts::empty()).unwrap();
        assert_eq!((layer.transform.scale_x, layer.transform.x.fract()), (1.0, 0.0));
        let out = apply(&layer, &meta.effect).unwrap();
        assert_eq!(out.transform.scale_x, 1.0);
        assert_eq!((out.transform.x, out.transform.y), (layer.transform.x - 3.0, layer.transform.y - 3.0));
        assert_eq!(out.image.width, layer.image.width + 6);
    }

    /// Timings behind ADR-0008 (run: cargo test --release -- --ignored effect_timings --nocapture).
    #[test]
    #[ignore = "a timing report, not a check"]
    fn effect_timings() {
        for side in [512u32, 1000, 2000] {
            let source = layer(square(side, side / 8, side - side / 8, [200, 50, 50]), LayerTransform::IDENTITY);
            for (name, effect) in [("outline 10", outline("#ffffff", 10.0)), ("outline 50", outline("#ffffff", 50.0)), ("glow 30", glow(30.0, 0.7, 0.8)), ("glow 100", glow(100.0, 0.7, 0.8))] {
                let start = std::time::Instant::now();
                let out = apply(&source, &effect).unwrap();
                println!("{side} px, {name}: {:?} ({}x{})", start.elapsed(), out.image.width, out.image.height);
            }
        }
    }
}

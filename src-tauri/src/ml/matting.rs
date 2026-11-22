//! Pre- and post-processing around the segmentation model (ADR-0006),
//! kept apart from ONNX Runtime so it is unit-tested on synthetic images:
//! the layer becomes the model's input tensor, and the model's output map
//! becomes an alpha mask applied to the layer.

use fast_image_resize::images::Image as FirImage;
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};

use super::model::ModelSpec;
use crate::editor::{resize, Rgba};

/// The model's input for `image`: 1×3×side×side f32, channels first (R, G,
/// B planes). The layer is stretched to the square (rembg does the same),
/// its alpha ignored, scaled to 0-1 by its brightest channel value, then
/// normalised with the model's mean and std.
pub fn model_input(image: &Rgba, spec: &ModelSpec) -> Result<Vec<f32>, String> {
    let side = spec.input_side;
    // Opaque first, so the resampler (which weights by alpha) sees every colour.
    let mut opaque = image.clone();
    for px in opaque.pixels.as_chunks_mut::<4>().0.iter_mut() {
        px[3] = 255;
    }
    let square = resize(opaque, (side, side))?;
    let brightest = square
        .pixels
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|px| &px[..3])
        .copied()
        .max()
        .unwrap_or(0);
    let scale = if brightest == 0 { 1.0 } else { f32::from(brightest) };
    let plane = (side * side) as usize;
    let mut input = vec![0.0f32; 3 * plane];
    for (i, px) in square.pixels.as_chunks::<4>().0.iter().enumerate() {
        for c in 0..3 {
            input[c * plane + i] = (f32::from(px[c]) / scale - spec.mean[c]) / spec.std[c];
        }
    }
    Ok(input)
}

/// The model's output map (one `side`×`side` plane) as an 8-bit mask,
/// min-max normalised as rembg does for ISNet. A flat map separates
/// nothing, so it keeps everything (all 255).
pub fn mask_from_output(prediction: &[f32], side: u32) -> Result<Vec<u8>, String> {
    let plane = (side * side) as usize;
    if prediction.len() < plane {
        return Err(format!(
            "the background removal model returned {} values, expected {plane}",
            prediction.len()
        ));
    }
    let map = &prediction[..plane];
    let (low, high) = map
        .iter()
        .filter(|v| v.is_finite())
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    let range = high - low;
    if !range.is_finite() || range <= 1e-6 {
        return Ok(vec![255; plane]);
    }
    Ok(map
        .iter()
        .map(|&v| {
            let v = if v.is_finite() { v } else { low };
            (((v - low) / range) * 255.0).round().clamp(0.0, 255.0) as u8
        })
        .collect())
}

/// Resample a `side`×`side` mask to the layer's size with Lanczos3.
pub fn resize_mask(mask: Vec<u8>, side: u32, (width, height): (u32, u32)) -> Result<Vec<u8>, String> {
    if (width, height) == (side, side) {
        return Ok(mask);
    }
    let failed = |e: &dyn std::fmt::Display| format!("cannot resize the background mask: {e}");
    let src = FirImage::from_vec_u8(side, side, mask, PixelType::U8).map_err(|e| failed(&e))?;
    let mut dst = FirImage::new(width, height, PixelType::U8);
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    Resizer::new().resize(&src, &mut dst, &options).map_err(|e| failed(&e))?;
    Ok(dst.into_vec())
}

/// The layer with its alpha multiplied by `mask` (one byte per pixel).
/// Colours are never changed, so the refine brush can restore them exactly.
pub fn apply_mask(image: &Rgba, mask: &[u8]) -> Result<Rgba, String> {
    if mask.len() * 4 != image.pixels.len() {
        return Err("the background mask does not match the layer's size".into());
    }
    let mut out = image.clone();
    for (px, &m) in out.pixels.as_chunks_mut::<4>().0.iter_mut().zip(mask) {
        px[3] = ((u16::from(px[3]) * u16::from(m) + 127) / 255) as u8;
    }
    Ok(out)
}

/// True when any pixel is at least partly visible.
pub fn has_visible_pixels(image: &Rgba) -> bool {
    image.pixels.as_chunks::<4>().0.iter().any(|px| px[3] > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(side: u32) -> ModelSpec {
        ModelSpec { input_side: side, mean: [0.5, 0.5, 0.5], std: [1.0, 1.0, 1.0], ..super::super::model::MODEL }
    }

    fn solid(width: u32, height: u32, px: [u8; 4]) -> Rgba {
        Rgba { width, height, pixels: px.repeat((width * height) as usize) }
    }

    #[test]
    fn input_is_channels_first_scaled_by_the_brightest_value_and_normalised() {
        // Brightest channel value is 200: red 200 -> 1.0, green 100 -> 0.5, blue 0 -> 0.
        let input = model_input(&solid(4, 4, [200, 100, 0, 255]), &spec(2)).unwrap();
        assert_eq!(input.len(), 3 * 2 * 2);
        let near = |a: f32, b: f32| (a - b).abs() < 1e-3;
        assert!(input[..4].iter().all(|&v| near(v, 0.5)), "red plane: {:?}", &input[..4]);
        assert!(input[4..8].iter().all(|&v| near(v, 0.0)), "green plane: {:?}", &input[4..8]);
        assert!(input[8..].iter().all(|&v| near(v, -0.5)), "blue plane: {:?}", &input[8..]);
    }

    #[test]
    fn input_ignores_alpha_so_transparent_colour_still_counts() {
        let opaque = model_input(&solid(3, 3, [90, 60, 30, 255]), &spec(3)).unwrap();
        let clear = model_input(&solid(3, 3, [90, 60, 30, 0]), &spec(3)).unwrap();
        assert_eq!(opaque, clear);
    }

    #[test]
    fn an_all_black_layer_does_not_divide_by_zero() {
        let input = model_input(&solid(2, 2, [0, 0, 0, 255]), &spec(2)).unwrap();
        assert!(input.iter().all(|&v| (v + 0.5).abs() < 1e-6));
    }

    #[test]
    fn output_is_min_max_normalised_to_a_byte_mask() {
        let mask = mask_from_output(&[2.0, 4.0, 3.0, 2.0], 2).unwrap();
        assert_eq!(mask, vec![0, 255, 128, 0]);
    }

    #[test]
    fn a_flat_output_keeps_everything() {
        assert_eq!(mask_from_output(&[0.3; 4], 2).unwrap(), vec![255; 4]);
    }

    #[test]
    fn a_short_output_is_an_error() {
        assert!(mask_from_output(&[0.0; 3], 2).is_err());
    }

    #[test]
    fn the_mask_is_resized_to_the_layer_and_keeps_its_halves() {
        // Left half background, right half subject, at 8×8 -> 16×4.
        let mut mask = vec![0u8; 64];
        for y in 0..8 {
            for x in 4..8 {
                mask[y * 8 + x] = 255;
            }
        }
        let out = resize_mask(mask, 8, (16, 4)).unwrap();
        assert_eq!(out.len(), 64);
        for y in 0..4 {
            assert_eq!(out[y * 16], 0, "far left stays background");
            assert_eq!(out[y * 16 + 15], 255, "far right stays subject");
        }
    }

    #[test]
    fn the_mask_multiplies_alpha_and_leaves_colour_alone() {
        let image = Rgba { width: 3, height: 1, pixels: vec![10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 255] };
        let out = apply_mask(&image, &[0, 255, 128]).unwrap();
        assert_eq!(out.pixels, vec![10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 128]);
        assert!(has_visible_pixels(&out));
        assert!(!has_visible_pixels(&apply_mask(&image, &[0, 0, 0]).unwrap()));
    }

    #[test]
    fn a_mask_of_the_wrong_size_is_refused() {
        assert!(apply_mask(&solid(2, 2, [0, 0, 0, 255]), &[0; 3]).is_err());
    }
}

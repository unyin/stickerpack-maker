//! "Merge selected layers" (SPEC §6): composite raster layers, each placed
//! by its transform exactly as the Konva view draws it (translate, then
//! rotate, then scale, about the layer's top-left), into one layer covering
//! their union. Text layers arrive as text, not pixels: each is rasterised
//! from its outlines at its transform (text.rs) and composited like the rest.

use super::placement::{check_extent, from_pixmap, place_layers, render_window, LayerInput, PlacedImage};

/// Composite two or more raster layers, bottom to top, source-over, into
/// one image covering the union of their transformed bounds.
pub fn merge(layers: &[LayerInput]) -> Result<PlacedImage, String> {
    if layers.len() < 2 {
        return Err("merging needs at least two layers".to_string());
    }
    render_layers(layers)
}

/// Merge's rendering for at least one layer; `merge` adds the two-layer
/// minimum. Crop's tests call it directly to reach merge's size check.
pub(super) fn render_layers(layers: &[LayerInput]) -> Result<PlacedImage, String> {
    let placed = place_layers(layers)?;
    check_extent(placed.width, placed.height, "merged layer")?;
    let canvas = render_window(&placed, placed.left as i32, placed.top as i32, placed.width, placed.height)?;
    Ok(PlacedImage { x: placed.left as i32, y: placed.top as i32, image: from_pixmap(&canvas) })
}

#[cfg(test)]
mod tests {
    use super::super::placement::LayerTransform;
    use super::super::Rgba;
    use super::*;

    fn solid(width: u32, height: u32, px: [u8; 4]) -> Rgba {
        Rgba { width, height, pixels: px.repeat((width * height) as usize) }
    }

    fn at(image: Rgba, x: f32, y: f32) -> LayerInput {
        LayerInput { image, transform: LayerTransform { x, y, ..LayerTransform::IDENTITY } }
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
        let scaled = LayerInput {
            image: solid(2, 2, [255, 0, 0, 255]),
            transform: LayerTransform { scale_x: 2.0, scale_y: 2.0, ..LayerTransform::IDENTITY },
        };
        let merged = merge(&[at(base.clone(), 0.0, 0.0), scaled]).unwrap();
        assert_eq!((merged.image.width, merged.image.height), (4, 4));
        assert!(close(pixel(&merged, 3, 3), [255, 0, 0, 255]));
        // 4x2 rotated 90 degrees clockwise about its top-left at (0,0)
        // swings down-left: it covers x in [-2, 0), y in [0, 4).
        let rotated = LayerInput {
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
        let stripes = LayerInput {
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
        let huge = LayerInput {
            image: solid(2, 2, [0, 0, 0, 255]),
            transform: LayerTransform { scale_x: 10_000.0, scale_y: 1.0, ..LayerTransform::IDENTITY },
        };
        assert!(merge(&[one.clone(), huge]).unwrap_err().contains("too large"));
        let broken = LayerInput {
            image: Rgba { width: 2, height: 2, pixels: vec![0; 3] },
            transform: LayerTransform::IDENTITY,
        };
        assert!(merge(&[one.clone(), broken]).is_err());
        let nan = LayerInput {
            image: solid(1, 1, [0, 0, 0, 255]),
            transform: LayerTransform { x: f32::NAN, ..LayerTransform::IDENTITY },
        };
        assert!(merge(&[one, nan]).is_err());
    }
}

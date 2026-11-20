//! "Cut" (SPEC §6, SPM-9): move the pixels of a raster layer that lie inside
//! a selection (a rectangle or a lasso, as a polygon in document pixels) into
//! a new floating layer. The source keeps a transparent hole.
//!
//! The selection is mapped into the layer's own pixel grid through the
//! inverse of its transform (translate, rotate, scale; merge.rs), so a
//! rotated or scaled layer is cut where it is drawn. A pixel is selected
//! when its centre is inside the polygon (even-odd rule, so a lasso that
//! crosses itself leaves the overlap out), and it moves whole: no
//! resampling, no anti-aliased seam, and the cutout put back in place
//! recomposes the original exactly. The cutout is the bounding box of the
//! selected visible pixels, in the layer's pixel grid: the webview gives it
//! the source's rotation and scale at that spot.

use serde::Deserialize;
use tiny_skia::Point;

use super::merge::{transform_of, LayerMeta, MergeInput, PlacedImage};
use super::Rgba;

/// Metadata of a cut request: the source layer (as for merge) and the
/// selection polygon in document pixels.
#[derive(Debug, Clone, Deserialize)]
pub struct CutMeta {
    #[serde(flatten)]
    pub layer: LayerMeta,
    pub polygon: Vec<[f32; 2]>,
}

/// What a cut produces: the source with a hole, and the cutout placed in
/// the source's pixel grid (`x`, `y` are layer pixels, not document ones).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cut {
    pub hole: Rgba,
    pub cutout: PlacedImage,
}

impl Cut {
    /// Binary IPC frame: the hole's RGBA bytes (its size is the source's,
    /// known to the webview), then `PlacedImage::to_frame` of the cutout.
    pub fn to_frame(&self) -> Vec<u8> {
        let mut frame = self.hole.pixels.clone();
        frame.extend_from_slice(&self.cutout.to_frame());
        frame
    }
}

/// Why nothing could be cut: the selection holds no visible pixel of the layer.
pub const NOTHING_TO_CUT: &str = "The selection holds no visible pixels of this layer; nothing was cut.";

/// For each row of a `width` x `height` grid, the pixel spans whose centres
/// are inside `polygon` (even-odd), as half-open [start, end) ranges.
fn spans(polygon: &[Point], width: u32, height: u32) -> Vec<Vec<(u32, u32)>> {
    let mut rows = vec![Vec::new(); height as usize];
    for (y, row) in rows.iter_mut().enumerate() {
        let cy = y as f32 + 0.5;
        let mut crossings: Vec<f32> = Vec::new();
        for (i, a) in polygon.iter().enumerate() {
            let b = polygon[(i + 1) % polygon.len()];
            // Half-open in y, so a vertex on the scanline counts once.
            if (a.y <= cy) != (b.y <= cy) {
                crossings.push(a.x + (cy - a.y) / (b.y - a.y) * (b.x - a.x));
            }
        }
        crossings.sort_by(f32::total_cmp);
        for &[from, to] in crossings.as_chunks::<2>().0 {
            // Pixels whose centre x + 0.5 lies in [from, to).
            let start = (from - 0.5).ceil().clamp(0.0, width as f32) as u32;
            let end = (to - 0.5).ceil().clamp(0.0, width as f32) as u32;
            if start < end {
                row.push((start, end));
            }
        }
    }
    rows
}

/// Cut `polygon` (document pixels) out of `layer`.
pub fn cut(layer: &MergeInput, polygon: &[[f32; 2]]) -> Result<Cut, String> {
    let (width, height) = (layer.image.width, layer.image.height);
    if layer.image.pixels.len() != width as usize * height as usize * 4 {
        return Err("the layer's pixels do not match its size".to_string());
    }
    if polygon.len() < 3 || polygon.iter().flatten().any(|v| !v.is_finite()) {
        return Err("a selection needs at least three finite points".to_string());
    }
    let inverse = transform_of(&layer.transform)?
        .invert()
        .ok_or_else(|| "the layer is scaled to nothing, so it cannot be cut".to_string())?;
    let mut local: Vec<Point> = polygon.iter().map(|&[x, y]| Point::from_xy(x, y)).collect();
    inverse.map_points(&mut local);
    let mut hole = layer.image.clone();
    let mut moved = vec![0u8; hole.pixels.len()];
    let (mut left, mut top, mut right, mut bottom) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for (y, row) in spans(&local, width, height).into_iter().enumerate() {
        for (start, end) in row {
            for x in start..end {
                let i = (y * width as usize + x as usize) * 4;
                if hole.pixels[i + 3] == 0 {
                    continue; // nothing visible to move
                }
                moved[i..i + 4].copy_from_slice(&hole.pixels[i..i + 4]);
                hole.pixels[i..i + 4].fill(0);
                (left, top) = (left.min(x), top.min(y as u32));
                (right, bottom) = (right.max(x + 1), bottom.max(y as u32 + 1));
            }
        }
    }
    if left >= right {
        return Err(NOTHING_TO_CUT.to_string());
    }
    let (cw, ch) = (right - left, bottom - top);
    let mut pixels = Vec::with_capacity(cw as usize * ch as usize * 4);
    for y in top..bottom {
        let start = (y as usize * width as usize + left as usize) * 4;
        pixels.extend_from_slice(&moved[start..start + cw as usize * 4]);
    }
    Ok(Cut {
        hole,
        cutout: PlacedImage { x: left as i32, y: top as i32, image: Rgba { width: cw, height: ch, pixels } },
    })
}

#[cfg(test)]
mod tests {
    use super::super::merge::LayerTransform;
    use super::*;

    /// Pixel (x, y) is [x, y, 7, 255].
    fn coords(width: u32, height: u32) -> Rgba {
        let mut pixels = Vec::new();
        for y in 0..height {
            for x in 0..width {
                pixels.extend_from_slice(&[x as u8, y as u8, 7, 255]);
            }
        }
        Rgba { width, height, pixels }
    }

    fn px(image: &Rgba, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width + x) * 4) as usize;
        image.pixels[i..i + 4].try_into().unwrap()
    }

    fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<[f32; 2]> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    fn layer(image: Rgba, transform: LayerTransform) -> MergeInput {
        MergeInput { image, transform }
    }

    #[test]
    fn a_rectangle_moves_exactly_its_pixels_and_leaves_a_hole() {
        // Layer at (10, 20); select document x 12..15, y 21..23 = layer x 2..5, y 1..3.
        let source = layer(coords(8, 6), LayerTransform { x: 10.0, y: 20.0, ..LayerTransform::IDENTITY });
        let out = cut(&source, &rect(12.0, 21.0, 15.0, 23.0)).unwrap();
        assert_eq!((out.cutout.x, out.cutout.y), (2, 1));
        assert_eq!((out.cutout.image.width, out.cutout.image.height), (3, 2));
        assert_eq!(px(&out.cutout.image, 0, 0), [2, 1, 7, 255]);
        assert_eq!(px(&out.cutout.image, 2, 1), [4, 2, 7, 255]);
        for y in 0..6 {
            for x in 0..8 {
                let inside = (2..5).contains(&x) && (1..3).contains(&y);
                let expected = if inside { [0, 0, 0, 0] } else { [x as u8, y as u8, 7, 255] };
                assert_eq!(px(&out.hole, x, y), expected, "hole at ({x},{y})");
            }
        }
    }

    #[test]
    fn a_selection_past_the_layer_edge_takes_only_the_layers_pixels() {
        let source = layer(coords(4, 4), LayerTransform::IDENTITY);
        let out = cut(&source, &rect(-10.0, 2.0, 10.0, 10.0)).unwrap();
        assert_eq!((out.cutout.x, out.cutout.y, out.cutout.image.width, out.cutout.image.height), (0, 2, 4, 2));
    }

    #[test]
    fn transparent_pixels_do_not_count_and_trim_the_cutout() {
        let mut image = coords(6, 6);
        for p in image.pixels.chunks_mut(4) {
            if p[0] < 3 {
                p[3] = 0; // left half invisible
            }
        }
        let out = cut(&layer(image.clone(), LayerTransform::IDENTITY), &rect(0.0, 0.0, 6.0, 6.0)).unwrap();
        assert_eq!((out.cutout.x, out.cutout.image.width), (3, 3));
        let empty = cut(&layer(image, LayerTransform::IDENTITY), &rect(0.0, 0.0, 3.0, 6.0));
        assert_eq!(empty.unwrap_err(), NOTHING_TO_CUT);
    }

    #[test]
    fn a_scaled_and_rotated_layer_is_cut_where_it_is_drawn() {
        // Scale 2: document (4..8, 0..4) is layer pixels x 2..4, y 0..2.
        let scaled = layer(coords(8, 8), LayerTransform { scale_x: 2.0, scale_y: 2.0, ..LayerTransform::IDENTITY });
        let out = cut(&scaled, &rect(4.0, 0.0, 8.0, 4.0)).unwrap();
        assert_eq!((out.cutout.x, out.cutout.y, out.cutout.image.width, out.cutout.image.height), (2, 0, 2, 2));
        // Rotated 90 degrees clockwise at (10, 0): layer (u, v) is drawn at
        // document (10 - v, u). Document x 8..10, y 0..3 = layer v 0..2, u 0..3.
        let rotated = layer(coords(8, 8), LayerTransform { x: 10.0, rotation: 90.0, ..LayerTransform::IDENTITY });
        let out = cut(&rotated, &rect(8.0, 0.0, 10.0, 3.0)).unwrap();
        assert_eq!((out.cutout.x, out.cutout.y, out.cutout.image.width, out.cutout.image.height), (0, 0, 3, 2));
    }

    #[test]
    fn a_lasso_selects_pixel_centres_inside_with_the_even_odd_rule() {
        // A triangle (0,0) (8,0) (0,8): pixel (x, y) is in when x + y + 1 < 8.
        let source = layer(coords(8, 8), LayerTransform::IDENTITY);
        let out = cut(&source, &[[0.0, 0.0], [8.0, 0.0], [0.0, 8.0]]).unwrap();
        assert_eq!(px(&out.hole, 6, 0)[3], 0);
        assert_eq!(px(&out.hole, 7, 0)[3], 255, "centre (7.5, 0.5) is on the edge's far side");
        assert_eq!(px(&out.hole, 3, 3)[3], 0);
        assert_eq!(px(&out.hole, 4, 4)[3], 255);
        // An hourglass crossing itself at (4, 4): its left and right lobes
        // are in, the wedges above and below the crossing are not.
        let bow = [[0.0, 0.0], [8.0, 8.0], [8.0, 0.0], [0.0, 8.0]];
        let out = cut(&source, &bow).unwrap();
        assert_eq!(px(&out.hole, 0, 4)[3], 0, "left lobe is inside");
        assert_eq!(px(&out.hole, 7, 4)[3], 0, "right lobe is inside");
        assert_eq!(px(&out.hole, 4, 0)[3], 255, "above the crossing is outside");
    }

    #[test]
    fn degenerate_selections_and_transforms_are_refused() {
        let source = layer(coords(4, 4), LayerTransform::IDENTITY);
        assert!(cut(&source, &[[0.0, 0.0], [4.0, 4.0]]).is_err());
        assert!(cut(&source, &[[0.0, 0.0], [f32::NAN, 4.0], [4.0, 0.0]]).is_err());
        let flat = layer(coords(4, 4), LayerTransform { scale_x: 0.0, ..LayerTransform::IDENTITY });
        assert!(cut(&flat, &rect(0.0, 0.0, 4.0, 4.0)).is_err());
    }

    #[test]
    fn the_frame_is_the_hole_then_the_placed_cutout() {
        let source = layer(coords(2, 1), LayerTransform::IDENTITY);
        let out = cut(&source, &rect(1.0, 0.0, 2.0, 1.0)).unwrap();
        let frame = out.to_frame();
        assert_eq!(&frame[..8], &[0, 0, 7, 255, 0, 0, 0, 0]);
        assert_eq!(&frame[8..16], &[1, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&frame[16..24], &[1, 0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(&frame[24..], &[1, 0, 7, 255]);
    }

    #[test]
    fn meta_json_carries_the_polygon() {
        let meta: CutMeta = serde_json::from_str(
            r#"{"width":2,"height":1,"transform":{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0},
                "polygon":[[0,0],[1,0],[1,1]]}"#,
        )
        .unwrap();
        assert_eq!(meta.polygon.len(), 3);
        assert!(meta.layer.text.is_none());
    }
}

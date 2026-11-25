//! The magic-wand selection (SPEC §6, SPM-22): the flood fill that selects
//! the colour-similar region around a clicked spot, and the cut and erase
//! operations on the resulting coverage mask. One-shot pixel work in Rust
//! (ADR-0005), like Cut.
//!
//! `select` flood-fills 4-connected from the clicked pixel (mapped into the
//! layer's own grid through the inverse of its transform, like `cut`): a
//! pixel matches when it is visible and no RGB channel deviates more than
//! the tolerance (a percent of full range) from the clicked sample. The
//! mask carries partial coverage — 255 inside, 128 on the boundary ring —
//! so an erase or a cut through the anti-aliased band around manga ink
//! lines lands softly (owner decision 2026-11-24: the 1-px feather is
//! wand-only; Rectangle/Lasso stay whole-pixel). The feather applies only
//! where a non-selected neighbour exists INSIDE the image: a selection that
//! runs to the layer's own edge stays fully covered there, so erasing a
//! manga background to the panel edge leaves no faint half-covered line
//! along it. A mask cut keeps the hole/cutout alphas an exact complement,
//! so a cutout put back in place recomposes the original like `cut`'s
//! whole-pixel moves do.

use serde::Deserialize;
use tiny_skia::Point;

use super::cut::{Cut, CutMode, NOTHING_TO_ERASE, NOTHING_TO_CUT};
use super::layers::{decode_layer, finish_body, LayerMeta};
use super::placement::{transform_of, LayerInput, PlacedImage};
use super::Rgba;

/// Coverage of one selected pixel: fully in, or the 1-px feather's half.
pub(super) const INSIDE: u8 = 255;
/// The 1-px feather: a selected pixel beside a non-selected neighbour.
pub(super) const FEATHER: u8 = 128;

/// Why a fully transparent spot cannot start a selection. The webview
/// refuses it before the round trip; this is the server-side twin.
pub const TRANSPARENT_SPOT: &str = "Nothing to select there: that spot is fully transparent.";
/// Why a click outside the layer selects nothing. Same arrangement.
pub const OUTSIDE_LAYER: &str = "Nothing to select there: that spot is outside the layer.";

/// Metadata of a wand request: the target layer (raster only, like cut) and
/// the click in document pixels, the tolerance as a percent, and whether
/// the fill feathers its boundary.
#[derive(Debug, Clone, Deserialize)]
pub struct WandMeta {
    #[serde(flatten)]
    pub layer: LayerMeta,
    /// The clicked spot, in document pixels.
    pub seed: [f32; 2],
    /// Per-channel tolerance as a percent of full range (0-100, whole).
    pub tolerance: u32,
    /// Whether the boundary ring takes half coverage. On when absent, so
    /// requests without it keep the feathered behaviour (owner decision
    /// 2026-11-24: the Feather checkbox, on by default).
    #[serde(default = "feathers_by_default")]
    pub feather: bool,
}

/// The wand feathers its boundary unless a request says otherwise.
fn feathers_by_default() -> bool {
    true
}

impl WandMeta {
    /// The target layer from the request body: raster only, text cannot be wanded.
    pub fn decode_layer(&self, body: &[u8]) -> Result<LayerInput, String> {
        let mut rest = body;
        let layer = decode_layer(&self.layer, &mut rest, |_, _| Err("text layers cannot be selected".to_string()))?;
        finish_body(rest)?;
        Ok(layer)
    }
}

/// A coverage mask in the target layer's own pixel grid: per pixel how
/// strongly the wand selected it (0-255), cropped to the selected bounds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WandMask {
    /// The mask's top-left in layer pixels.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// `width * height` coverage bytes, row-major.
    pub coverage: Vec<u8>,
}

/// The mask's place in the layer's grid, as the cut/erase request carries it.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct MaskPlace {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl WandMask {
    /// Binary IPC frame: i32 LE x, i32 LE y, u32 LE width, u32 LE height,
    /// then the coverage bytes.
    pub fn to_frame(&self) -> Vec<u8> {
        let mut frame = Vec::with_capacity(16 + self.coverage.len());
        frame.extend_from_slice(&self.x.to_le_bytes());
        frame.extend_from_slice(&self.y.to_le_bytes());
        frame.extend_from_slice(&self.width.to_le_bytes());
        frame.extend_from_slice(&self.height.to_le_bytes());
        frame.extend_from_slice(&self.coverage);
        frame
    }

    /// The mask of `place` from the request body's tail, which must hold
    /// exactly its bytes (the layer's pixels come first, as for cut).
    pub fn from_body(place: &MaskPlace, body: &[u8]) -> Result<WandMask, String> {
        let len = place.width as usize * place.height as usize;
        if body.len() < len {
            return Err("the request body is shorter than its mask".to_string());
        }
        if body.len() > len {
            return Err("the request body is longer than its mask".to_string());
        }
        Ok(WandMask { x: place.x, y: place.y, width: place.width, height: place.height, coverage: body.to_vec() })
    }
}

/// Metadata of a mask cut or erase: the target layer, the mask's place in
/// its grid (the coverage rides as raw bytes after the layer's) and the
/// mode — lift into a new floating layer, or erase in place.
#[derive(Debug, Clone, Deserialize)]
pub struct CutMaskMeta {
    #[serde(flatten)]
    pub layer: LayerMeta,
    pub mask: MaskPlace,
    #[serde(default)]
    pub mode: CutMode,
}

impl CutMaskMeta {
    /// The layer and its mask from the request body: the layer's RGBA bytes,
    /// then the mask's coverage.
    pub fn decode(&self, body: &[u8]) -> Result<(LayerInput, WandMask), String> {
        let mut rest = body;
        let layer = decode_layer(&self.layer, &mut rest, |_, _| Err("text layers cannot be cut".to_string()))?;
        let mask = WandMask::from_body(&self.mask, rest)?;
        Ok((layer, mask))
    }
}

/// True when `px` is visible and no RGB channel deviates more than `max`
/// from the clicked sample `seed`.
fn matches(seed: [u8; 3], max: u32, px: &[u8]) -> bool {
    px[3] > 0
        && u32::from(px[0].abs_diff(seed[0])) <= max
        && u32::from(px[1].abs_diff(seed[1])) <= max
        && u32::from(px[2].abs_diff(seed[2])) <= max
}

/// Select the colour-similar contiguous region around the document-space
/// `seed` on `layer`, at `tolerance` percent per channel, feathering the
/// boundary ring unless `feather` is false.
pub fn select(layer: &LayerInput, seed: &[f32; 2], tolerance: u32, feather: bool) -> Result<WandMask, String> {
    let (width, height) = (layer.image.width, layer.image.height);
    if layer.image.pixels.len() != width as usize * height as usize * 4 {
        return Err("the layer's pixels do not match its size".to_string());
    }
    if tolerance > 100 {
        return Err("the wand tolerance must be a whole number from 0 to 100".to_string());
    }
    if !seed.iter().all(|v| v.is_finite()) {
        return Err("the clicked spot is not a finite point".to_string());
    }
    if width == 0 || height == 0 {
        return Err("the layer has no pixels".to_string());
    }
    if layer.transform.scale_x == 0.0 || layer.transform.scale_y == 0.0 {
        return Err("the layer is scaled to nothing, so it cannot be selected".to_string());
    }
    let inverse = transform_of(&layer.transform)?
        .invert()
        .ok_or_else(|| "the layer is scaled to nothing, so it cannot be selected".to_string())?;
    let mut local = [Point::from_xy(seed[0], seed[1])];
    inverse.map_points(&mut local);
    let (sx, sy) = (local[0].x, local[0].y);
    if !(0.0..width as f32).contains(&sx) || !(0.0..height as f32).contains(&sy) {
        return Err(OUTSIDE_LAYER.to_string());
    }
    let (sx, sy) = (sx as u32, sy as u32);
    let base = (sy * width + sx) as usize * 4;
    if layer.image.pixels[base + 3] == 0 {
        return Err(TRANSPARENT_SPOT.to_string());
    }
    let sample = [layer.image.pixels[base], layer.image.pixels[base + 1], layer.image.pixels[base + 2]];
    let max = tolerance * u32::from(u8::MAX) / 100;

    // 4-connected scanline flood fill of the matching pixels. A popped pixel
    // that is filled already or does not match does nothing. Otherwise its
    // row span is filled through the matching, unfilled pixels either side,
    // and the rows above and below queue one pixel at the start of each run
    // of matching, unfilled pixels within the span's columns — never beyond
    // them, so the fill never crosses a diagonal gap.
    let mut filled = vec![false; width as usize * height as usize];
    let pixels = &layer.image.pixels;
    let fillable = |filled: &[bool], x: u32, y: u32| {
        let i = (y * width + x) as usize;
        !filled[i] && matches(sample, max, &pixels[i * 4..])
    };
    let mut stack = vec![(sx, sy)];
    while let Some((x, y)) = stack.pop() {
        if !fillable(&filled, x, y) {
            continue;
        }
        let mut left = x;
        while left > 0 && fillable(&filled, left - 1, y) {
            left -= 1;
        }
        let mut right = x;
        while right + 1 < width && fillable(&filled, right + 1, y) {
            right += 1;
        }
        for fx in left..=right {
            filled[(y * width + fx) as usize] = true;
        }
        for ny in [y.checked_sub(1), (y + 1 < height).then_some(y + 1)].into_iter().flatten() {
            let mut in_run = false;
            for nx in left..=right {
                let run = fillable(&filled, nx, ny);
                if run && !in_run {
                    stack.push((nx, ny));
                }
                in_run = run;
            }
        }
    }

    // The 1-px feather: a selected pixel beside a NON-selected neighbour
    // inside the image takes partial coverage. The image's own edge is not a
    // feather — a selection running to the layer's edge stays fully covered.
    // With the feather switched off every selected pixel is fully in.
    let coverage = (0..width as usize * height as usize)
        .map(|i| {
            if !filled[i] {
                return 0;
            }
            let (x, y) = ((i % width as usize) as u32, (i / width as usize) as u32);
            let edge = (x > 0 && !filled[i - 1])
                || (x + 1 < width && !filled[i + 1])
                || (y > 0 && !filled[i - width as usize])
                || (y + 1 < height && !filled[i + width as usize]);
            if edge && feather { FEATHER } else { INSIDE }
        })
        .collect::<Vec<u8>>();

    // Crop to the selected bounds. The seed is visible and matches itself,
    // so the selection is never empty and the bounds are well ordered.
    let mut xs = [width, 0u32];
    let mut ys = [height, 0u32];
    for (i, covered) in filled.iter().enumerate() {
        if !covered {
            continue;
        }
        let (x, y) = ((i % width as usize) as u32, (i / width as usize) as u32);
        xs[0] = xs[0].min(x);
        xs[1] = xs[1].max(x + 1);
        ys[0] = ys[0].min(y);
        ys[1] = ys[1].max(y + 1);
    }
    let (x, w) = (xs[0], xs[1] - xs[0]);
    let (y, h) = (ys[0], ys[1] - ys[0]);
    let mut cropped = Vec::with_capacity(w as usize * h as usize);
    for row in 0..h {
        let from = ((y + row) * width + x) as usize;
        cropped.extend_from_slice(&coverage[from..from + w as usize]);
    }
    Ok(WandMask { x: x as i32, y: y as i32, width: w, height: h, coverage: cropped })
}

/// The mask against the layer: its place and byte count must fit.
fn check_mask(layer: &LayerInput, mask: &WandMask) -> Result<(), String> {
    if mask.width == 0 || mask.height == 0 {
        return Err("the mask has no pixels".to_string());
    }
    if mask.coverage.len() != mask.width as usize * mask.height as usize {
        return Err("the mask's coverage does not match its size".to_string());
    }
    let right = i64::from(mask.x) + i64::from(mask.width);
    let bottom = i64::from(mask.y) + i64::from(mask.height);
    if mask.x < 0 || mask.y < 0 || right > i64::from(layer.image.width) || bottom > i64::from(layer.image.height) {
        return Err("the mask does not fit the layer".to_string());
    }
    Ok(())
}

/// How a covered pixel splits: the hole keeps `(255 - c)/255` of the alpha,
/// the cutout the exact complement, so the two recompose the original.
fn split_alpha(alpha: u8, coverage: u8) -> (u8, u8) {
    let keep = (u32::from(alpha) * u32::from(255 - coverage)) / 255;
    let keep = keep as u8;
    (keep, alpha - keep)
}

/// Cut a coverage mask out of `layer` (SPM-9's Cut on a wand selection):
/// the source keeps the alpha the mask does not cover it with, and the
/// covered pixels move into a new floating cutout at the same spot. One
/// undo step in the model; the cutout is trimmed to the pixels it carries.
pub fn cut_mask(layer: &LayerInput, mask: &WandMask) -> Result<Cut, String> {
    check_mask(layer, mask)?;
    let width = layer.image.width as usize;
    let mut hole = layer.image.clone();
    let mut moved = vec![0u8; hole.pixels.len()];
    let (mut left, mut top, mut right, mut bottom) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for row in 0..mask.height as usize {
        for column in 0..mask.width as usize {
            let coverage = mask.coverage[row * mask.width as usize + column];
            if coverage == 0 {
                continue;
            }
            let x = mask.x as u32 + column as u32;
            let y = mask.y as u32 + row as u32;
            let i = (y as usize * width + x as usize) * 4;
            let (keep, take) = split_alpha(hole.pixels[i + 3], coverage);
            hole.pixels[i + 3] = keep;
            if take == 0 {
                continue; // nothing visible to move
            }
            moved[i..i + 4].copy_from_slice(&hole.pixels[i..i + 4]);
            moved[i + 3] = take;
            (left, top) = (left.min(x), top.min(y));
            (right, bottom) = (right.max(x + 1), bottom.max(y + 1));
        }
    }
    if left >= right {
        return Err(NOTHING_TO_CUT.to_string());
    }
    let (cw, ch) = (right - left, bottom - top);
    let mut pixels = Vec::with_capacity(cw as usize * ch as usize * 4);
    for y in top..bottom {
        let from = (y as usize * width + left as usize) * 4;
        pixels.extend_from_slice(&moved[from..from + cw as usize * 4]);
    }
    Ok(Cut { hole, cutout: PlacedImage { x: left as i32, y: top as i32, image: Rgba { width: cw, height: ch, pixels } } })
}

/// Erase a coverage mask from `layer` in place: each covered pixel keeps
/// `(255 - c)/255` of its alpha (nothing, for a fully covered one). The
/// model keeps the layer's restore source, so Restore brings the pixels
/// back (owner decision 2026-11-24).
pub fn erase_mask(layer: &LayerInput, mask: &WandMask) -> Result<Rgba, String> {
    check_mask(layer, mask)?;
    let width = layer.image.width as usize;
    let mut hole = layer.image.clone();
    let mut erased = false;
    for row in 0..mask.height as usize {
        for column in 0..mask.width as usize {
            let coverage = mask.coverage[row * mask.width as usize + column];
            if coverage == 0 {
                continue;
            }
            let i = ((mask.y as usize + row) * width + mask.x as usize + column) * 4;
            if hole.pixels[i + 3] == 0 {
                continue; // nothing visible to erase
            }
            let (keep, _) = split_alpha(hole.pixels[i + 3], coverage);
            hole.pixels[i + 3] = keep;
            erased = true;
        }
    }
    if !erased {
        return Err(NOTHING_TO_ERASE.to_string());
    }
    Ok(hole)
}

#[cfg(test)]
mod tests {
    use super::super::placement::LayerTransform;
    use super::*;

    /// Every pixel one colour, opaque.
    fn flat(width: u32, height: u32, rgb: [u8; 3]) -> Rgba {
        Rgba { width, height, pixels: [rgb[0], rgb[1], rgb[2], 255].repeat((width * height) as usize) }
    }

    fn layer(image: Rgba, transform: LayerTransform) -> LayerInput {
        LayerInput { image, transform }
    }

    fn px(image: &Rgba, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width + x) * 4) as usize;
        image.pixels[i..i + 4].try_into().unwrap()
    }

    fn cover(mask: &WandMask, x: u32, y: u32) -> u8 {
        mask.coverage[(y * mask.width + x) as usize]
    }

    /// Whether the unfeathered mask covers the layer pixel (x, y).
    fn selected(mask: &WandMask, x: u32, y: u32) -> bool {
        let (mx, my) = (i64::from(x) - i64::from(mask.x), i64::from(y) - i64::from(mask.y));
        (0..i64::from(mask.width)).contains(&mx)
            && (0..i64::from(mask.height)).contains(&my)
            && cover(mask, mx as u32, my as u32) != 0
    }

    /// Paint the layer pixel (x, y) opaque `rgb`.
    fn set(image: &mut Rgba, x: u32, y: u32, rgb: [u8; 3]) {
        let i = ((y * image.width + x) * 4) as usize;
        image.pixels[i..i + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
    }

    /// The manga shape: a white page with a vertical ink band and a gray
    /// anti-aliasing column beside it.
    fn manga() -> Rgba {
        let mut image = flat(8, 8, [255, 255, 255]);
        for y in 0..8 {
            for x in 3..5 {
                set(&mut image, x, y, [0, 0, 0]); // the ink line
            }
            set(&mut image, 5, y, [128, 128, 128]); // anti-aliased band
        }
        image
    }

    #[test]
    fn a_click_selects_the_white_around_the_ink_and_stops_at_it() {
        let source = layer(manga(), LayerTransform::IDENTITY);
        let mask = select(&source, &[1.5, 1.5], 20, true).unwrap();
        // The connected white left of the ink band; the gray band and the
        // right-hand white are other components.
        assert_eq!((mask.x, mask.y, mask.width, mask.height), (0, 0, 3, 8));
        for y in 0..8 {
            assert_eq!(cover(&mask, 0, y), INSIDE, "the image edge is not a feather");
            assert_eq!(cover(&mask, 1, y), INSIDE);
            assert_eq!(cover(&mask, 2, y), FEATHER, "the ink boundary feathers");
        }
    }

    #[test]
    fn the_feather_can_be_switched_off() {
        // The same manga click, unfeathered: the ink boundary stays fully in.
        let source = layer(manga(), LayerTransform::IDENTITY);
        let mask = select(&source, &[1.5, 1.5], 20, false).unwrap();
        assert_eq!((mask.x, mask.y, mask.width, mask.height), (0, 0, 3, 8));
        for y in 0..8 {
            for x in 0..3 {
                assert_eq!(cover(&mask, x, y), INSIDE, "a hard edge at ({x},{y})");
            }
        }
    }

    #[test]
    fn tolerance_admits_a_deviation_up_to_the_percent_and_contiguity_stops_there() {
        // White seed; tolerance 20 admits a deviation up to 51 of 255.
        let mut image = flat(4, 1, [255, 255, 255]);
        image.pixels[4..8].copy_from_slice(&[204, 204, 204, 255]); // exactly at the limit
        image.pixels[8..12].copy_from_slice(&[203, 203, 203, 255]); // one past it
        let mask = select(&layer(image.clone(), LayerTransform::IDENTITY), &[0.5, 0.5], 20, true).unwrap();
        assert_eq!((mask.x, mask.width), (0, 2));
        // A gray seed on the other side of the 203 pixel selects nothing new.
        let mask = select(&layer(image, LayerTransform::IDENTITY), &[3.5, 0.5], 20, true).unwrap();
        assert_eq!((mask.x, mask.width), (3, 1));
    }

    #[test]
    fn transparent_pixels_never_match_and_block_the_fill() {
        let mut image = flat(3, 1, [255, 255, 255]);
        image.pixels[4..8].fill(0);
        let mask = select(&layer(image, LayerTransform::IDENTITY), &[0.5, 0.5], 100, true).unwrap();
        assert_eq!(mask.width, 1);
        assert_eq!(cover(&mask, 0, 0), FEATHER);
    }

    #[test]
    fn a_scaled_layer_is_selected_where_it_is_drawn() {
        // Scale 2: document x 12..16 is layer pixels x 6..8 — the white
        // right of the anti-aliased band, unreachable by this click unscaled.
        let source = layer(manga(), LayerTransform { scale_x: 2.0, scale_y: 2.0, ..LayerTransform::IDENTITY });
        let mask = select(&source, &[13.0, 1.0], 20, true).unwrap();
        assert_eq!((mask.x, mask.y, mask.width, mask.height), (6, 0, 2, 8));
        assert_eq!(cover(&mask, 0, 0), FEATHER, "the gray band's boundary feathers");
        assert_eq!(cover(&mask, 1, 0), INSIDE, "the image edge is not a feather");
        // The same click on the unscaled layer is outside it entirely.
        let unscaled = layer(manga(), LayerTransform::IDENTITY);
        assert_eq!(select(&unscaled, &[13.0, 1.0], 20, true).unwrap_err(), OUTSIDE_LAYER);
    }

    #[test]
    fn refused_clicks_and_layers() {
        let source = layer(flat(4, 4, [9, 9, 9]), LayerTransform::IDENTITY);
        assert_eq!(select(&source, &[-1.0, 1.0], 20, true).unwrap_err(), OUTSIDE_LAYER);
        assert_eq!(select(&source, &[4.0, 1.0], 20, true).unwrap_err(), OUTSIDE_LAYER);
        assert_eq!(select(&source, &[f32::NAN, 1.0], 20, true).unwrap_err(), "the clicked spot is not a finite point");
        assert_eq!(select(&source, &[1.0, 1.0], 101, true).unwrap_err(), "the wand tolerance must be a whole number from 0 to 100");
        let mut transparent = flat(2, 2, [255, 255, 255]);
        transparent.pixels.fill(0);
        assert_eq!(select(&layer(transparent, LayerTransform::IDENTITY), &[0.5, 0.5], 20, true).unwrap_err(), TRANSPARENT_SPOT);
        let flat_scale = layer(flat(2, 2, [255, 255, 255]), LayerTransform { scale_x: 0.0, ..LayerTransform::IDENTITY });
        assert_eq!(
            select(&flat_scale, &[0.5, 0.5], 20, true).unwrap_err(),
            "the layer is scaled to nothing, so it cannot be selected",
        );
    }

    #[test]
    fn the_frame_carries_place_size_and_coverage() {
        let mask = WandMask { x: -1, y: 2, width: 2, height: 1, coverage: vec![255, 128] };
        assert_eq!(
            mask.to_frame(),
            vec![255, 255, 255, 255, 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 255, 128],
        );
        // The same mask round-trips from a body of exactly its bytes.
        let place = MaskPlace { x: -1, y: 2, width: 2, height: 1 };
        assert_eq!(WandMask::from_body(&place, &[255, 128]).unwrap(), mask);
        assert!(WandMask::from_body(&place, &[255]).is_err());
        assert!(WandMask::from_body(&place, &[255, 128, 7]).is_err());
    }

    #[test]
    fn meta_json_carries_the_seed_tolerance_and_mask_place() {
        let meta: WandMeta = serde_json::from_str(
            r#"{"width":2,"height":1,"transform":{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0},
                "seed":[1.5,0.5],"tolerance":20}"#,
        )
        .unwrap();
        assert_eq!(meta.seed, [1.5, 0.5]);
        assert_eq!(meta.tolerance, 20);
        assert!(meta.layer.text.is_none());
        assert!(meta.feather, "the feather defaults on when the request omits it");
        let meta: WandMeta = serde_json::from_str(
            r#"{"width":2,"height":1,"transform":{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0},
                "seed":[1.5,0.5],"tolerance":20,"feather":false}"#,
        )
        .unwrap();
        assert!(!meta.feather);
        let meta: CutMaskMeta = serde_json::from_str(
            r#"{"width":2,"height":1,"transform":{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0},
                "mask":{"x":0,"y":0,"width":2,"height":1},"mode":"erase"}"#,
        )
        .unwrap();
        assert_eq!(meta.mode, CutMode::Erase);
        // Without a mode the lift is the default (SPM-9's Cut unchanged).
        let lift: CutMaskMeta = serde_json::from_str(
            r#"{"width":2,"height":1,"transform":{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0},
                "mask":{"x":0,"y":0,"width":2,"height":1}}"#,
        )
        .unwrap();
        assert_eq!(lift.mode, CutMode::Lift);
    }

    #[test]
    fn a_mask_cut_splits_alpha_so_the_pieces_recompose_the_original() {
        // A fully covered pixel moves whole; a feathered one splits its alpha.
        let mask = WandMask { x: 0, y: 0, width: 2, height: 1, coverage: vec![255, 128] };
        let source = layer(flat(2, 1, [10, 20, 30]), LayerTransform::IDENTITY);
        let out = cut_mask(&source, &mask).unwrap();
        assert_eq!(px(&out.hole, 0, 0), [10, 20, 30, 0]);
        assert_eq!(px(&out.hole, 1, 0), [10, 20, 30, 127]);
        assert_eq!((out.cutout.x, out.cutout.y, out.cutout.image.width, out.cutout.image.height), (0, 0, 2, 1));
        assert_eq!(px(&out.cutout.image, 0, 0), [10, 20, 30, 255]);
        assert_eq!(px(&out.cutout.image, 1, 0), [10, 20, 30, 128]);
        // The exact complement: the pieces recompose the source.
        for x in 0..2 {
            assert_eq!(px(&out.hole, x, 0)[3] + px(&out.cutout.image, x, 0)[3], 255);
        }
    }

    #[test]
    fn a_mask_cut_trims_to_the_carried_pixels_and_refuses_empty_ones() {
        // Coverage only on the second pixel; the first carries nothing.
        let mask = WandMask { x: 1, y: 0, width: 2, height: 1, coverage: vec![0, 255] };
        let source = layer(flat(3, 1, [7, 7, 7]), LayerTransform::IDENTITY);
        let out = cut_mask(&source, &mask).unwrap();
        assert_eq!((out.cutout.x, out.cutout.image.width), (2, 1));
        // Fully transparent pixels move nothing, so a mask over only those is refused.
        let mut transparent = flat(2, 1, [7, 7, 7]);
        transparent.pixels[3] = 0;
        transparent.pixels[7] = 0;
        let mask = WandMask { x: 0, y: 0, width: 2, height: 1, coverage: vec![255, 255] };
        assert_eq!(cut_mask(&layer(transparent, LayerTransform::IDENTITY), &mask).unwrap_err(), NOTHING_TO_CUT);
    }

    #[test]
    fn a_mask_cut_refuses_masks_that_do_not_fit() {
        let source = layer(flat(2, 2, [7, 7, 7]), LayerTransform::IDENTITY);
        let wrong_size = WandMask { x: 0, y: 0, width: 2, height: 1, coverage: vec![255] };
        assert!(cut_mask(&source, &wrong_size).is_err());
        let outside = WandMask { x: 1, y: 1, width: 2, height: 2, coverage: vec![255; 4] };
        assert!(cut_mask(&source, &outside).is_err());
        let negative = WandMask { x: -1, y: 0, width: 2, height: 1, coverage: vec![255, 255] };
        assert!(cut_mask(&source, &negative).is_err());
        let empty = WandMask { x: 0, y: 0, width: 0, height: 0, coverage: vec![] };
        assert!(cut_mask(&source, &empty).is_err());
    }

    #[test]
    fn a_mask_erase_keeps_the_uncovered_part_of_each_alpha() {
        let mask = WandMask { x: 0, y: 0, width: 2, height: 1, coverage: vec![255, 128] };
        let source = layer(flat(2, 1, [10, 20, 30]), LayerTransform::IDENTITY);
        let out = erase_mask(&source, &mask).unwrap();
        assert_eq!(px(&out, 0, 0), [10, 20, 30, 0]);
        assert_eq!(px(&out, 1, 0), [10, 20, 30, 127]);
        // Coverage over nothing visible erases nothing and says so.
        let mut transparent = flat(2, 1, [7, 7, 7]);
        transparent.pixels.fill(0);
        let mask = WandMask { x: 0, y: 0, width: 2, height: 1, coverage: vec![255, 255] };
        assert_eq!(erase_mask(&layer(transparent, LayerTransform::IDENTITY), &mask).unwrap_err(), NOTHING_TO_ERASE);
    }

    #[test]
    fn a_white_page_speckled_with_ink_is_selected_whole() {
        // Isolated ink dots leave every white pixel 4-connected to the rest.
        let dots = [(2, 3), (5, 3), (8, 3), (4, 4), (9, 5)];
        let mut image = flat(12, 8, [255, 255, 255]);
        for (x, y) in dots {
            set(&mut image, x, y, [0, 0, 0]);
        }
        let mask = select(&layer(image, LayerTransform::IDENTITY), &[0.5, 0.5], 20, false).unwrap();
        for y in 0..8 {
            for x in 0..12 {
                assert_eq!(selected(&mask, x, y), !dots.contains(&(x, y)), "pixel ({x},{y})");
            }
        }
        assert_eq!(mask.coverage.iter().filter(|c| **c != 0).count(), 12 * 8 - dots.len());
    }

    #[test]
    fn a_diagonal_line_of_ink_is_not_crossed() {
        // White either side of an anti-diagonal of ink touches only corner to
        // corner, which is not 4-connected.
        let mut image = flat(5, 5, [255, 255, 255]);
        for x in 0..5 {
            set(&mut image, x, 4 - x, [0, 0, 0]);
        }
        let mask = select(&layer(image, LayerTransform::IDENTITY), &[0.5, 0.5], 20, false).unwrap();
        for y in 0..5 {
            for x in 0..5 {
                assert_eq!(selected(&mask, x, y), x + y < 4, "pixel ({x},{y})");
            }
        }
    }

    #[test]
    fn a_queued_ink_pixel_does_not_spread_left_into_a_diagonal_white() {
        // White at (1,1) is the click; (0,0) is white too but touches it only
        // at a corner, with ink at (1,0) and (0,1) between them.
        let mut image = flat(2, 2, [0, 0, 0]);
        set(&mut image, 0, 0, [255, 255, 255]);
        set(&mut image, 1, 1, [255, 255, 255]);
        let mask = select(&layer(image, LayerTransform::IDENTITY), &[1.5, 1.5], 20, false).unwrap();
        assert_eq!((mask.x, mask.y, mask.width, mask.height), (1, 1, 1, 1));
    }

    #[test]
    fn the_wand_matches_a_naive_four_connected_fill_on_noisy_images() {
        // Deterministic pseudo-random images, a few tolerances and seeds.
        let mut state = 12345_u32;
        let mut next = move || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 16) as u8
        };
        for tolerance in [0, 10, 40] {
            for _ in 0..6 {
                let (w, h) = (17_u32, 11_u32);
                let mut image = flat(w, h, [0, 0, 0]);
                for y in 0..h {
                    for x in 0..w {
                        // Mostly light with scattered darker and mid pixels.
                        let v = match next() % 8 {
                            0 => 0,
                            1 => 90,
                            2 => 200,
                            _ => 255,
                        };
                        set(&mut image, x, y, [v, v, v]);
                    }
                }
                let (sx, sy) = (u32::from(next()) % w, u32::from(next()) % h);
                let max = tolerance * 255 / 100;
                let sample = px(&image, sx, sy);
                let seed = [sample[0], sample[1], sample[2]];
                let mut expected = vec![false; (w * h) as usize];
                let mut stack = vec![(sx, sy)];
                expected[(sy * w + sx) as usize] = true;
                while let Some((x, y)) = stack.pop() {
                    let around = [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)];
                    for (nx, ny) in around {
                        let i = (ny.wrapping_mul(w).wrapping_add(nx)) as usize;
                        if nx < w && ny < h && !expected[i] && matches(seed, max, &image.pixels[i * 4..]) {
                            expected[i] = true;
                            stack.push((nx, ny));
                        }
                    }
                }
                let source = layer(image, LayerTransform::IDENTITY);
                let mask = select(&source, &[sx as f32 + 0.5, sy as f32 + 0.5], tolerance, false).unwrap();
                for y in 0..h {
                    for x in 0..w {
                        assert_eq!(
                            selected(&mask, x, y),
                            expected[(y * w + x) as usize],
                            "tolerance {tolerance}, seed ({sx},{sy}), pixel ({x},{y})"
                        );
                    }
                }
            }
        }
    }
}

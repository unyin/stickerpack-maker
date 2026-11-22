//! The save flatten (SPEC §6 Save, ADR-0005): every layer drawn into the
//! canvas, bottom to top, and nothing outside it (owner decision
//! 2026-11-20: saving clips what lies outside the canvas). Raster layers are
//! placed like merge places them (placement.rs), so a saved image matches a
//! merge of the same layers pixel for pixel inside the canvas. Text layers
//! are rasterised from their outlines straight into the canvas window
//! (text.rs `rasterise_window`), sharp at their drawn size and costing only
//! the canvas's memory however far they overflow it.
//!
//! The constraint sets are checked here on the flattened size, and the
//! encoder (encode.rs) holds the bytes to the set's cap: the hard block of
//! SPEC §6-7 lives in Rust, on what is actually written.

use fontdb::Database;
use serde::Deserialize;

use super::encode::{encode_within, EncodeOutcome, SaveFormat};
use super::layers::{decode_layer, finish_body, LayerMeta};
use super::placement::{check_window, from_pixmap, place_layers, render_window, LayerInput, LayerTransform};
use super::text::rasterise_window;
use super::Rgba;
use crate::limits::{KB, STICKER_MAX_KB, STICKER_SIDE, THUMBNAIL_MAX_KB, THUMBNAIL_SIDE};

/// What a saved image must meet; mirrors `ConstraintSet` in
/// src/editor/model/constraints.ts (values from src/shared/limits.json).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConstraintSet {
    /// Longest side exactly `STICKER_SIDE`, file at most `STICKER_MAX_KB`.
    Sticker,
    /// Exactly `THUMBNAIL_SIDE` square, file at most `THUMBNAIL_MAX_KB`.
    Thumbnail,
}

impl ConstraintSet {
    pub fn max_kilobytes(self) -> u64 {
        match self {
            ConstraintSet::Sticker => STICKER_MAX_KB,
            ConstraintSet::Thumbnail => THUMBNAIL_MAX_KB,
        }
    }

    pub fn max_bytes(self) -> usize {
        (self.max_kilobytes() * KB) as usize
    }

    /// Why a `width`x`height` image cannot be saved under this set, or None.
    pub fn size_problem(self, width: u32, height: u32) -> Option<String> {
        match self {
            ConstraintSet::Sticker if width.max(height) != STICKER_SIDE => Some(format!(
                "a sticker's longest side must be exactly {STICKER_SIDE} px; this image is {width}×{height} px"
            )),
            ConstraintSet::Thumbnail if (width, height) != (THUMBNAIL_SIDE, THUMBNAIL_SIDE) => Some(format!(
                "a thumbnail must be exactly {THUMBNAIL_SIDE}×{THUMBNAIL_SIDE} px; this image is {width}×{height} px"
            )),
            _ => None,
        }
    }
}

/// A save request's document: the canvas size and its layers, bottom to
/// top (as for merge: raster bytes in the body, text as text).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDoc {
    pub width: u32,
    pub height: u32,
    pub layers: Vec<LayerMeta>,
}

/// Split a save request's body into placeable layers. A text layer is
/// rasterised into the canvas window and arrives aligned at (0, 0).
pub fn split_save_layers(doc: &SaveDoc, body: &[u8], fonts: &Database) -> Result<Vec<LayerInput>, String> {
    check_window(doc.width, doc.height, "canvas")?;
    let mut rest = body;
    let layers = doc
        .layers
        .iter()
        .map(|m| {
            decode_layer(m, &mut rest, |spec, t| {
                let image = rasterise_window(fonts, spec, t, 0, 0, doc.width, doc.height)?;
                Ok(LayerInput { image, transform: LayerTransform::IDENTITY })
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    finish_body(rest)?;
    Ok(layers)
}

/// Draw `layers` into a `width`x`height` canvas whose top-left is the
/// document origin; what lies outside it is clipped.
pub fn flatten(layers: &[LayerInput], width: u32, height: u32) -> Result<Rgba, String> {
    check_window(width, height, "canvas")?;
    if layers.is_empty() {
        return Err("there is nothing to save".to_string());
    }
    let placed = place_layers(layers)?;
    Ok(from_pixmap(&render_window(&placed, 0, 0, width, height)?))
}

/// The whole save pixel path: check the canvas size against `set`, flatten,
/// and encode as `format` within the set's byte cap. The caller writes
/// `EncodeOutcome::Fits`; `TooLarge` is reported to the user.
pub fn render_for_save(
    set: ConstraintSet,
    doc: &SaveDoc,
    body: &[u8],
    fonts: &Database,
    format: SaveFormat,
) -> Result<EncodeOutcome, String> {
    if let Some(problem) = set.size_problem(doc.width, doc.height) {
        return Err(format!("Not saved: {problem}."));
    }
    let layers = split_save_layers(doc, body, fonts)?;
    let image = flatten(&layers, doc.width, doc.height)?;
    encode_within(&image, format, set.max_bytes())
}

#[cfg(test)]
mod tests {
    use super::super::encode::tests::noise;
    use super::super::merge::merge;
    use super::super::placement::LayerTransform;
    use super::*;

    fn solid(width: u32, height: u32, px: [u8; 4]) -> Rgba {
        Rgba { width, height, pixels: px.repeat((width * height) as usize) }
    }

    fn px(image: &Rgba, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width + x) * 4) as usize;
        image.pixels[i..i + 4].try_into().unwrap()
    }

    fn at(image: Rgba, x: f32, y: f32) -> LayerInput {
        LayerInput { image, transform: LayerTransform { x, y, ..LayerTransform::IDENTITY } }
    }

    fn raster_meta(width: u32, height: u32, x: f32, y: f32) -> LayerMeta {
        LayerMeta { width, height, transform: LayerTransform { x, y, ..LayerTransform::IDENTITY }, text: None }
    }

    #[test]
    fn the_canvas_clips_layers_that_overflow_it() {
        // A 6x6 red layer at (-2, -2) on a 4x3 canvas, a blue 2x2 on top at (3, 2).
        let out = flatten(
            &[at(solid(6, 6, [255, 0, 0, 255]), -2.0, -2.0), at(solid(2, 2, [0, 0, 255, 255]), 3.0, 2.0)],
            4,
            3,
        )
        .unwrap();
        assert_eq!((out.width, out.height), (4, 3));
        assert_eq!(px(&out, 0, 0), [255, 0, 0, 255]);
        assert_eq!(px(&out, 3, 2), [0, 0, 255, 255]);
        assert_eq!(px(&out, 2, 2), [255, 0, 0, 255]);
        assert_eq!(px(&out, 3, 1), [255, 0, 0, 255]);
    }

    #[test]
    fn uncovered_canvas_is_transparent() {
        let out = flatten(&[at(solid(1, 1, [9, 9, 9, 255]), 0.0, 0.0)], 3, 2).unwrap();
        assert_eq!(px(&out, 0, 0), [9, 9, 9, 255]);
        assert_eq!(px(&out, 2, 1)[3], 0);
    }

    #[test]
    fn inside_the_canvas_the_flatten_matches_merge() {
        // Rotated and scaled layers: the save sees what merge (and the view) sees.
        let layers = [
            at(noise(20, 12), 1.0, 2.0),
            LayerInput {
                image: noise(9, 7),
                transform: LayerTransform { x: 10.5, y: 3.25, scale_x: 1.5, scale_y: 0.75, rotation: 30.0 },
            },
        ];
        let merged = merge(&layers).unwrap();
        let out = flatten(&layers, 16, 10).unwrap();
        for y in 0..10 {
            for x in 0..16 {
                let (mx, my) = (x as i32 - merged.x, y as i32 - merged.y);
                let inside = mx >= 0 && my >= 0 && (mx as u32) < merged.image.width && (my as u32) < merged.image.height;
                let expected = if inside { px(&merged.image, mx as u32, my as u32) } else { [0, 0, 0, 0] };
                assert_eq!(px(&out, x, y), expected, "at ({x},{y})");
            }
        }
    }

    #[test]
    fn text_is_drawn_into_the_canvas_and_clipped() {
        // "A" at 100 px placed at (10, 0) inks x 20..60, y 10..80 (text.rs);
        // a 40x40 canvas keeps its top-left part only.
        let fonts = super::super::test_font::database();
        let doc: SaveDoc = serde_json::from_str(&format!(
            r##"{{"width":40,"height":40,"layers":[
                {{"width":40,"height":40,"transform":{{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0}}}},
                {{"width":60,"height":100,"transform":{{"x":10,"y":0,"scaleX":1,"scaleY":1,"rotation":0}},
                  "text":{{"text":"A","fontFamily":"{}","fontSize":100,"color":"#ff0000"}}}}]}}"##,
            super::super::test_font::FAMILY
        ))
        .unwrap();
        let body = [255u8; 40 * 40 * 4];
        let layers = split_save_layers(&doc, &body, &fonts).unwrap();
        assert_eq!((layers[1].image.width, layers[1].image.height), (40, 40));
        let out = flatten(&layers, 40, 40).unwrap();
        assert_eq!(px(&out, 20, 10), [255, 0, 0, 255]);
        assert_eq!(px(&out, 39, 39), [255, 0, 0, 255]);
        assert_eq!(px(&out, 19, 10), [255, 255, 255, 255]);
    }

    #[test]
    fn the_body_must_match_the_layers() {
        let fonts = Database::new();
        let doc = SaveDoc { width: 2, height: 2, layers: vec![raster_meta(1, 1, 0.0, 0.0)] };
        assert!(split_save_layers(&doc, &[0; 4], &fonts).is_ok());
        assert!(split_save_layers(&doc, &[0; 3], &fonts).is_err());
        assert!(split_save_layers(&doc, &[0; 5], &fonts).is_err());
        let empty = SaveDoc { width: 0, height: 2, layers: vec![] };
        assert!(split_save_layers(&empty, &[], &fonts).is_err());
        assert!(flatten(&[], 2, 2).unwrap_err().contains("nothing"));
    }

    #[test]
    fn sticker_size_is_the_longest_side_exactly() {
        let s = ConstraintSet::Sticker;
        assert_eq!(s.size_problem(STICKER_SIDE, STICKER_SIDE), None);
        assert_eq!(s.size_problem(STICKER_SIDE, 1), None);
        assert_eq!(s.size_problem(1, STICKER_SIDE), None);
        assert!(s.size_problem(STICKER_SIDE - 1, STICKER_SIDE - 1).unwrap().contains("exactly"));
        assert!(s.size_problem(STICKER_SIDE + 1, 1).is_some());
        assert_eq!(s.max_bytes(), (STICKER_MAX_KB * KB) as usize);
    }

    #[test]
    fn thumbnail_size_is_exactly_square() {
        let t = ConstraintSet::Thumbnail;
        assert_eq!(t.size_problem(THUMBNAIL_SIDE, THUMBNAIL_SIDE), None);
        assert!(t.size_problem(THUMBNAIL_SIDE, THUMBNAIL_SIDE - 1).is_some());
        assert!(t.size_problem(THUMBNAIL_SIDE + 1, THUMBNAIL_SIDE).is_some());
        assert_eq!(t.max_bytes(), (THUMBNAIL_MAX_KB * KB) as usize);
    }

    fn raster_doc(width: u32, height: u32) -> (SaveDoc, Vec<u8>) {
        let image = noise(width, height);
        (SaveDoc { width, height, layers: vec![raster_meta(width, height, 0.0, 0.0)] }, image.pixels)
    }

    #[test]
    fn a_wrong_size_is_refused_before_anything_is_encoded() {
        let fonts = Database::new();
        let (doc, body) = raster_doc(STICKER_SIDE - 1, 4);
        let err = render_for_save(ConstraintSet::Sticker, &doc, &body, &fonts, SaveFormat::Png).unwrap_err();
        assert!(err.starts_with("Not saved:"), "{err}");
        let (doc, body) = raster_doc(THUMBNAIL_SIDE, THUMBNAIL_SIDE + 1);
        assert!(render_for_save(ConstraintSet::Thumbnail, &doc, &body, &fonts, SaveFormat::Webp).is_err());
    }

    #[test]
    fn conforming_images_encode_within_each_set_s_cap() {
        let fonts = Database::new();
        for (set, (w, h)) in [
            (ConstraintSet::Sticker, (STICKER_SIDE, STICKER_SIDE / 2)),
            (ConstraintSet::Thumbnail, (THUMBNAIL_SIDE, THUMBNAIL_SIDE)),
        ] {
            let (doc, body) = raster_doc(w, h);
            for format in [SaveFormat::Png, SaveFormat::Webp] {
                match render_for_save(set, &doc, &body, &fonts, format).unwrap() {
                    EncodeOutcome::Fits(out) => {
                        assert!(out.bytes.len() <= set.max_bytes());
                        let back = image::load_from_memory(&out.bytes).unwrap();
                        assert_eq!((back.width(), back.height()), (w, h));
                    }
                    // Noise at the full sticker size is too large as PNG.
                    EncodeOutcome::TooLarge { format: f, smallest } => {
                        assert_eq!((set, f), (ConstraintSet::Sticker, SaveFormat::Png));
                        assert!(smallest > set.max_bytes());
                    }
                }
            }
        }
    }
}

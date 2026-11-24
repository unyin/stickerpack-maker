//! Layers on the wire (SPEC §6): how merge, crop and cut requests describe
//! their layers, and the one place a described layer becomes a placeable
//! `LayerInput`. A raster layer takes its bytes from the request body; a
//! text layer takes none and is rasterised from its text by the caller's
//! `text` function, which differs per operation (merge draws the whole box,
//! crop only its clip).

use fontdb::Database;
use serde::Deserialize;

use super::placement::{LayerInput, LayerTransform, PlacedImage};
use super::text::{rasterise_placed, TextSpec};
use super::Rgba;

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

/// Decode one layer, advancing `body` past the bytes it takes. A raster
/// layer takes `width * height * 4` bytes; a text layer takes none and is
/// turned into an input by `text`.
pub fn decode_layer(
    meta: &LayerMeta,
    body: &mut &[u8],
    text: impl FnOnce(&TextSpec, &LayerTransform) -> Result<LayerInput, String>,
) -> Result<LayerInput, String> {
    if let Some(spec) = &meta.text {
        return text(spec, &meta.transform);
    }
    let len = meta.width as usize * meta.height as usize * 4;
    if body.len() < len {
        return Err("the request body is shorter than its layers".to_string());
    }
    let (pixels, rest) = body.split_at(len);
    *body = rest;
    Ok(LayerInput {
        image: Rgba { width: meta.width, height: meta.height, pixels: pixels.to_vec() },
        transform: meta.transform,
    })
}

/// Fail when a request body holds bytes no layer claimed.
pub fn finish_body(rest: &[u8]) -> Result<(), String> {
    if rest.is_empty() { Ok(()) } else { Err("the request body is longer than its layers".to_string()) }
}

/// Split the concatenated RGBA body of a merge request into layers, using
/// each raster layer's declared size. The body must be exactly the sum of
/// sizes. Text layers take no bytes: each is rasterised with `fonts` (and
/// the style's emoji chain, SPM-20) at its transform into the whole pixels
/// it covers, and becomes an aligned (integer-translated) raster input, so
/// compositing copies it exactly.
pub fn split_layers(
    meta: &[LayerMeta],
    body: &[u8],
    fonts: &Database,
    emoji: &super::emoji::EmojiFonts,
) -> Result<Vec<LayerInput>, String> {
    let mut rest = body;
    let layers = meta
        .iter()
        .map(|m| {
            decode_layer(m, &mut rest, |spec, t| {
                aligned_input(rasterise_placed(fonts, emoji, spec, t)?)
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    finish_body(rest)?;
    Ok(layers)
}

/// An already-drawn image as an aligned input: its pixels at its whole-pixel origin.
pub(super) fn aligned_input(placed: PlacedImage) -> Result<LayerInput, String> {
    let transform = LayerTransform { x: placed.x as f32, y: placed.y as f32, ..LayerTransform::IDENTITY };
    Ok(LayerInput { image: placed.image, transform })
}

#[cfg(test)]
mod tests {
    use super::super::emoji::EmojiFonts;
    use super::super::merge::merge;
    use super::*;

    fn pixel(p: &PlacedImage, doc_x: i32, doc_y: i32) -> [u8; 4] {
        let (lx, ly) = ((doc_x - p.x) as u32, (doc_y - p.y) as u32);
        let i = ((ly * p.image.width + lx) * 4) as usize;
        p.image.pixels[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn the_wire_body_splits_into_layers_by_their_sizes() {
        let fonts = Database::new();
        let meta = [
            LayerMeta { width: 1, height: 1, transform: LayerTransform::IDENTITY, text: None },
            LayerMeta { width: 2, height: 1, transform: LayerTransform { x: 5.0, ..LayerTransform::IDENTITY }, text: None },
        ];
        let body: Vec<u8> = (0..12).collect();
        let layers = split_layers(&meta, &body, &fonts, &EmojiFonts::empty()).unwrap();
        assert_eq!(layers[0].image.pixels, vec![0, 1, 2, 3]);
        assert_eq!(layers[1].image.pixels, (4..12).collect::<Vec<u8>>());
        assert_eq!(layers[1].transform.x, 5.0);
        assert!(split_layers(&meta, &body[..11], &fonts, &EmojiFonts::empty()).is_err());
        assert!(split_layers(&meta, &[body.clone(), vec![0]].concat(), &fonts, &EmojiFonts::empty()).is_err());
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
        let layers = split_layers(&meta, &body, &fonts, &EmojiFonts::empty()).unwrap();
        assert_eq!((layers[1].image.width, layers[1].image.height), (60, 100));
        let merged = merge(&layers).unwrap();
        assert_eq!((merged.x, merged.y, merged.image.width, merged.image.height), (0, 0, 100, 100));
        assert_eq!(pixel(&merged, 20, 10), [255, 0, 0, 255]);
        assert_eq!(pixel(&merged, 59, 79), [255, 0, 0, 255]);
        assert_eq!(pixel(&merged, 19, 10), [255, 255, 255, 255]);
        assert_eq!(pixel(&merged, 60, 50), [255, 255, 255, 255]);
        // A text layer whose font is missing is refused, not skipped.
        assert!(split_layers(&meta, &body, &Database::new(), &EmojiFonts::empty()).unwrap_err().contains("not installed"));
    }
}

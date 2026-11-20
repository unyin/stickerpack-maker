//! "Crop" (SPEC §6): discard each layer's content outside the crop box. The webview plans the crop (src/editor/model/document.ts
//! `planCrop`): for every layer crossing the box edge it sends the layer and
//! `clip`, the whole pixels the layer covers inside the box. Here each such
//! layer is re-rendered into exactly that rectangle, placed by its
//! transform the same way merge places it (and the Konva view draws it).
//! The result is an untransformed image whose top-left is `clip`'s. A text
//! layer crossing the box edge arrives as text and is rasterised first
//! (merge.rs `split_layers`), so it is clipped exactly like an image.

use fontdb::Database;
use serde::Deserialize;
use tiny_skia::Pixmap;

use super::merge::{
    draw_placed, from_pixmap, is_pixel_aligned, shrink_to_drawn_size, split_layers, to_pixmap, transform_of,
    LayerMeta, MergeInput, MAX_MERGE_SIDE,
};
use super::Rgba;

/// A rectangle of whole document pixels; mirrors `Rect` in document.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct ClipRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Per-layer metadata of a crop request: the layer's size and transform
/// (as for merge) plus the rectangle it is clipped to.
#[derive(Debug, Clone, Deserialize)]
pub struct CropMeta {
    #[serde(flatten)]
    pub layer: LayerMeta,
    pub clip: ClipRect,
}

/// Split a crop request's concatenated RGBA body into layers with their clips.
pub fn split_crop_layers(
    meta: &[CropMeta],
    body: &[u8],
    fonts: &Database,
) -> Result<Vec<(MergeInput, ClipRect)>, String> {
    let layers: Vec<LayerMeta> = meta.iter().map(|m| m.layer.clone()).collect();
    Ok(split_layers(&layers, body, fonts)?.into_iter().zip(meta.iter().map(|m| m.clip)).collect())
}

/// Render one layer into `clip`: the pixels the layer shows there, and
/// nothing from outside it.
pub fn crop_layer(layer: &MergeInput, clip: ClipRect) -> Result<Rgba, String> {
    if clip.width == 0 || clip.height == 0 {
        return Err("a crop rectangle has no pixels".to_string());
    }
    if clip.width > MAX_MERGE_SIDE || clip.height > MAX_MERGE_SIDE {
        return Err(format!("a {}x{} crop rectangle is too large", clip.width, clip.height));
    }
    let layer = shrink_to_drawn_size(layer)?;
    let transform = transform_of(&layer.transform)?;
    let pixmap = to_pixmap(&layer.image)?;
    let mut canvas =
        Pixmap::new(clip.width, clip.height).ok_or_else(|| "cannot allocate the cropped layer".to_string())?;
    draw_placed(&mut canvas, &pixmap, transform, is_pixel_aligned(&layer.transform), clip.x as f32, clip.y as f32);
    Ok(from_pixmap(&canvas))
}

/// Crop every layer of a request, in order; the response body is their
/// RGBA bytes concatenated (each clip's size is known to the webview).
pub fn crop(layers: &[(MergeInput, ClipRect)]) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    for (layer, clip) in layers {
        body.extend_from_slice(&crop_layer(layer, *clip)?.pixels);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::super::merge::{merge, LayerTransform, PlacedImage};
    use super::*;

    /// Pixel (x, y) is [x, y, 7, 255]: shows exactly which pixels survived.
    fn coords(width: u32, height: u32) -> Rgba {
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                pixels.extend_from_slice(&[x as u8, y as u8, 7, 255]);
            }
        }
        Rgba { width, height, pixels }
    }

    fn placed(image: Rgba, transform: LayerTransform) -> MergeInput {
        MergeInput { image, transform }
    }

    fn px(image: &Rgba, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width + x) * 4) as usize;
        image.pixels[i..i + 4].try_into().unwrap()
    }

    fn merged_px(p: &PlacedImage, doc_x: i32, doc_y: i32) -> [u8; 4] {
        px(&p.image, (doc_x - p.x) as u32, (doc_y - p.y) as u32)
    }

    #[test]
    fn an_untransformed_layer_keeps_exactly_the_pixels_inside_the_box() {
        // A 40x30 image at (-5, -3), clipped to a 20x20 box at (0, 0).
        let layer = placed(coords(40, 30), LayerTransform { x: -5.0, y: -3.0, ..LayerTransform::IDENTITY });
        let clip = ClipRect { x: 0, y: 0, width: 20, height: 20 };
        let out = crop_layer(&layer, clip).unwrap();
        assert_eq!((out.width, out.height), (20, 20));
        for y in 0..20 {
            for x in 0..20 {
                assert_eq!(px(&out, x, y), [x as u8 + 5, y as u8 + 3, 7, 255], "at ({x},{y})");
            }
        }
    }

    #[test]
    fn a_clip_at_an_offset_box_reads_the_layer_at_document_coordinates() {
        let layer = placed(coords(10, 10), LayerTransform { x: 2.0, y: 1.0, ..LayerTransform::IDENTITY });
        let out = crop_layer(&layer, ClipRect { x: 8, y: -4, width: 4, height: 8 }).unwrap();
        // Document (8, 1) is the layer's (6, 0); document rows above y=1 are empty.
        assert_eq!(px(&out, 0, 5), [6, 0, 7, 255]);
        assert_eq!(px(&out, 3, 7), [9, 2, 7, 255]);
        assert_eq!(px(&out, 0, 4)[3], 0);
    }

    #[test]
    fn a_rotated_or_scaled_layer_crops_to_what_merge_renders_inside_the_box() {
        // Pixel-exact against the merge placement: crop is a window onto it.
        // Each layer starts right of and below the box's top-left, and a
        // transparent pixel at (0, 0) puts merge's origin on the clip's, so
        // both draw with the same translation (a different integer origin
        // can shift f32 bilinear weights by one level).
        let transforms = [
            LayerTransform { x: 12.3, y: 0.0, rotation: 30.0, ..LayerTransform::IDENTITY },
            LayerTransform { x: 0.5, y: 3.25, scale_x: 1.7, scale_y: 1.7, ..LayerTransform::IDENTITY },
            LayerTransform { x: 25.0, y: 2.0, scale_x: 0.6, scale_y: 0.6, rotation: 90.0 },
        ];
        for t in transforms {
            let layer = placed(coords(24, 16), t);
            let empty = placed(Rgba { width: 1, height: 1, pixels: vec![0; 4] }, LayerTransform::IDENTITY);
            let reference = merge(&[empty, layer.clone()]).unwrap();
            assert_eq!((reference.x, reference.y), (0, 0));
            let clip = ClipRect { x: 0, y: 0, width: 20, height: 20 };
            let out = crop_layer(&layer, clip).unwrap();
            for y in 0..20 {
                for x in 0..20 {
                    let expected = if x as i32 >= reference.x + reference.image.width as i32
                        || y as i32 >= reference.y + reference.image.height as i32
                    {
                        [0, 0, 0, 0]
                    } else {
                        merged_px(&reference, x as i32, y as i32)
                    };
                    assert_eq!(px(&out, x, y), expected, "{t:?} at ({x},{y})");
                }
            }
        }
    }

    #[test]
    fn the_request_body_splits_by_layer_and_the_response_concatenates_clips() {
        let meta: Vec<CropMeta> = serde_json::from_str(
            r#"[{"width":2,"height":1,"transform":{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0},
                 "clip":{"x":1,"y":0,"width":1,"height":1}},
                {"width":1,"height":1,"transform":{"x":-1,"y":0,"scaleX":1,"scaleY":1,"rotation":0},
                 "clip":{"x":-1,"y":0,"width":1,"height":1}}]"#,
        )
        .unwrap();
        let body = [1, 2, 3, 255, 5, 6, 7, 255, 9, 10, 11, 255];
        let fonts = Database::new();
        let layers = split_crop_layers(&meta, &body, &fonts).unwrap();
        assert_eq!(layers[0].1, ClipRect { x: 1, y: 0, width: 1, height: 1 });
        assert_eq!(crop(&layers).unwrap(), vec![5, 6, 7, 255, 9, 10, 11, 255]);
        assert!(split_crop_layers(&meta, &body[..11], &fonts).is_err());
    }

    #[test]
    fn a_text_layer_crossing_the_box_is_clipped_as_its_glyphs() {
        // "A" at 100 px placed at (-30, 0): the glyph inks document x
        // -20..20, y 10..80. Clipped to x 0..30 it keeps x 0..20.
        let fonts = super::super::test_font::database();
        let meta: Vec<CropMeta> = serde_json::from_str(&format!(
            r##"[{{"width":60,"height":100,"transform":{{"x":-30,"y":0,"scaleX":1,"scaleY":1,"rotation":0}},
                  "text":{{"text":"A","fontFamily":"{}","fontSize":100,"color":"#00ff00"}},
                  "clip":{{"x":0,"y":0,"width":30,"height":100}}}}]"##,
            super::super::test_font::FAMILY
        ))
        .unwrap();
        let layers = split_crop_layers(&meta, &[], &fonts).unwrap();
        let out = crop_layer(&layers[0].0, layers[0].1).unwrap();
        assert_eq!((out.width, out.height), (30, 100));
        assert_eq!(px(&out, 0, 10), [0, 255, 0, 255]);
        assert_eq!(px(&out, 19, 79), [0, 255, 0, 255]);
        assert_eq!(px(&out, 20, 50)[3], 0);
        assert_eq!(px(&out, 10, 9)[3], 0);
    }

    #[test]
    fn empty_or_oversized_clips_and_bad_transforms_are_refused() {
        let layer = placed(coords(2, 2), LayerTransform::IDENTITY);
        assert!(crop_layer(&layer, ClipRect { x: 0, y: 0, width: 0, height: 1 }).is_err());
        assert!(crop_layer(&layer, ClipRect { x: 0, y: 0, width: MAX_MERGE_SIDE + 1, height: 1 }).is_err());
        let nan = placed(coords(2, 2), LayerTransform { rotation: f32::NAN, ..LayerTransform::IDENTITY });
        assert!(crop_layer(&nan, ClipRect { x: 0, y: 0, width: 1, height: 1 }).is_err());
    }
}

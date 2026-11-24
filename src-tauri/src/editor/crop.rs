//! "Crop" (SPEC §6): discard each layer's content outside the crop box. The
//! webview plans the crop (`planCrop` in src/editor/model/document.ts): for
//! every layer crossing the box edge it sends the layer and `clip`, the
//! whole pixels the layer covers inside the box. Here each such layer is
//! drawn by the shared placement (placement.rs) into a clip-sized pixmap, in
//! merge's sampling frame (see `crop_layer` for the edge-pixel caveat). The
//! result is an untransformed image whose top-left is `clip`'s. A text layer
//! crossing the box edge arrives as text and is rasterised straight into its
//! clip (text.rs `rasterise_window`), so it is clipped exactly like an image.

use fontdb::Database;
use serde::Deserialize;

use super::layers::{decode_layer, finish_body, LayerMeta};
use super::placement::{check_window, from_pixmap, place_layers, render_window, LayerInput, LayerTransform};
use super::text::{rasterise_window, TextWindow};
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
/// Raster layers take their bytes from the body, in order. A text layer takes
/// none: it is rasterised from its outlines into just its clip (text.rs
/// `rasterise_window`, the clip-sized window), arriving as an aligned raster
/// input at the clip's top-left, which `crop_layer` copies exactly.
pub fn split_crop_layers(
    meta: &[CropMeta],
    body: &[u8],
    fonts: &Database,
    emoji: &super::emoji::EmojiFonts,
) -> Result<Vec<(LayerInput, ClipRect)>, String> {
    let mut rest = body;
    let layers = meta
        .iter()
        .map(|m| {
            let clip = m.clip;
            let layer = decode_layer(&m.layer, &mut rest, |spec, t| {
                check_window(clip.width, clip.height, "crop")?;
                let window = TextWindow { x: clip.x, y: clip.y, width: clip.width, height: clip.height };
                let image = rasterise_window(fonts, emoji, spec, t, window)?;
                let transform = LayerTransform { x: clip.x as f32, y: clip.y as f32, ..LayerTransform::IDENTITY };
                Ok(LayerInput { image, transform })
            })?;
            Ok((layer, clip))
        })
        .collect::<Result<Vec<_>, String>>()?;
    finish_body(rest)?;
    Ok(layers)
}

/// Render one layer into `clip`: the pixels the layer shows there, and
/// nothing from outside it.
///
/// Sampling uses the shared placement (placement.rs, bounds floored to whole
/// pixels), but only a clip-sized pixmap is allocated: the window is moved
/// onto `clip` by a whole-pixel translation. Pixels visible in both match
/// merge's exactly; the shifted float translation can flip a silhouette-edge
/// pixel between covered and uncovered. A layer whose full render would be
/// too large for merge still crops, and memory follows the clip.
pub fn crop_layer(layer: &LayerInput, clip: ClipRect) -> Result<Rgba, String> {
    check_window(clip.width, clip.height, "crop")?;
    let placed = place_layers(std::slice::from_ref(layer))?;
    let canvas = render_window(&placed, clip.x, clip.y, clip.width, clip.height)?;
    Ok(from_pixmap(&canvas))
}

/// Crop every layer of a request, in order; the response body is their
/// RGBA bytes concatenated (each clip's size is known to the webview).
pub fn crop(layers: &[(LayerInput, ClipRect)]) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    for (layer, clip) in layers {
        body.extend_from_slice(&crop_layer(layer, *clip)?.pixels);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::super::emoji::EmojiFonts;
    use super::super::merge::merge;
    use super::super::placement::{PlacedImage, MAX_LAYER_SIDE};
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

    fn placed(image: Rgba, transform: LayerTransform) -> LayerInput {
        LayerInput { image, transform }
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
    fn a_rotated_scaled_layer_crossing_the_left_and_top_edges_matches_merge_up_to_edge_flips() {
        // The drag-to-crop case: the layer hangs over the box's left and top
        // edges, so merge's own origin is at negative document pixels. The
        // reference is merge's render of the same layer, read at document
        // coordinates inside the box; the crop must equal it byte for byte.
        let transforms = [
            LayerTransform { x: -6.3, y: -4.7, scale_x: 1.4, scale_y: 1.4, rotation: 30.0 },
            LayerTransform { x: -9.0, y: 2.5, scale_x: 1.9, scale_y: 0.8, rotation: -20.0 },
            LayerTransform { x: 3.0, y: -11.6, scale_x: 0.7, scale_y: 1.3, rotation: 75.0 },
        ];
        for t in transforms {
            let layer = placed(coords(30, 22), t);
            // merge needs two layers: a transparent pixel at the document origin,
            // which lies inside the layer's bounds, so the union is the layer's own.
            let empty = placed(Rgba { width: 1, height: 1, pixels: vec![0; 4] }, LayerTransform::IDENTITY);
            let reference = merge(&[empty, layer.clone()]).unwrap();
            assert!(reference.x < 0 && reference.y < 0, "{t:?} must cross the left and top edges");
            assert!(reference.image.width as i32 > -reference.x && reference.image.height as i32 > -reference.y);
            let clip = ClipRect { x: 0, y: 0, width: 24, height: 24 };
            let out = crop_layer(&layer, clip).unwrap();
            let mut visible = 0;
            let mut silhouette_flips = 0;
            for y in 0..24 {
                for x in 0..24 {
                    let (rx, ry) = (x as i32 - reference.x, y as i32 - reference.y);
                    let inside = rx >= 0 && ry >= 0 && rx < reference.image.width as i32 && ry < reference.image.height as i32;
                    let expected = if inside { merged_px(&reference, x as i32, y as i32) } else { [0, 0, 0, 0] };
                    let got = px(&out, x, y);
                    if got != expected {
                        // Moving the window shifts the f32 translation, which can
                        // flip a pixel the silhouette's edge passes through the
                        // centre of, between covered and not. Nothing else may differ.
                        assert!(got[3] == 0 || expected[3] == 0, "{t:?} at ({x},{y}): {got:?} vs {expected:?}");
                        silhouette_flips += 1;
                    }
                    visible += (expected[3] > 0) as u32;
                }
            }
            assert!(visible > 50, "{t:?}: the test must compare real pixels, saw {visible}");
            assert!(silhouette_flips <= 2, "{t:?}: {silhouette_flips} edge pixels differ from merge");
        }
    }

    #[test]
    fn a_layer_too_large_for_merge_still_crops_to_a_small_clip() {
        // 100x100 scaled 100x is 10000 px a side: merge refuses it, but the
        // clip is small, so crop succeeds and matches the nearby sampling.
        let layer = placed(coords(100, 100), LayerTransform { x: -4000.0, y: -4000.0, scale_x: 100.0, scale_y: 100.0, rotation: 0.0 });
        assert!(merge_refuses(&layer));
        let out = crop_layer(&layer, ClipRect { x: 0, y: 0, width: 8, height: 8 }).unwrap();
        // Document 0 is layer pixel 40 (4000 / 100).
        assert_eq!(px(&out, 0, 0), [40, 40, 7, 255]);
        assert_eq!(px(&out, 7, 7), [40, 40, 7, 255]);
    }

    fn merge_refuses(layer: &LayerInput) -> bool {
        super::super::merge::render_layers(std::slice::from_ref(layer))
            .err()
            .is_some_and(|e| e.contains("the merged layer would be"))
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
        let layers = split_crop_layers(&meta, &body, &fonts, &EmojiFonts::empty()).unwrap();
        assert_eq!(layers[0].1, ClipRect { x: 1, y: 0, width: 1, height: 1 });
        assert_eq!(crop(&layers).unwrap(), vec![5, 6, 7, 255, 9, 10, 11, 255]);
        assert!(split_crop_layers(&meta, &body[..11], &fonts, &EmojiFonts::empty()).is_err());
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
        let layers = split_crop_layers(&meta, &[], &fonts, &EmojiFonts::empty()).unwrap();
        let out = crop_layer(&layers[0].0, layers[0].1).unwrap();
        assert_eq!((out.width, out.height), (30, 100));
        assert_eq!(px(&out, 0, 10), [0, 255, 0, 255]);
        assert_eq!(px(&out, 19, 79), [0, 255, 0, 255]);
        assert_eq!(px(&out, 20, 50)[3], 0);
        assert_eq!(px(&out, 10, 9)[3], 0);
    }

    #[test]
    fn text_and_raster_layers_split_in_order_and_text_is_drawn_only_into_its_clip() {
        // A 2x1 raster, then "A" at 100 px placed at (-30, 0), then a 1x1
        // raster: the body holds only the rasters' bytes, in order.
        let fonts = super::super::test_font::database();
        let meta: Vec<CropMeta> = serde_json::from_str(&format!(
            r##"[{{"width":2,"height":1,"transform":{{"x":-1,"y":0,"scaleX":1,"scaleY":1,"rotation":0}},
                  "clip":{{"x":0,"y":0,"width":1,"height":1}}}},
                 {{"width":60,"height":100,"transform":{{"x":-30,"y":0,"scaleX":1,"scaleY":1,"rotation":0}},
                  "text":{{"text":"A","fontFamily":"{}","fontSize":100,"color":"#00ff00"}},
                  "clip":{{"x":0,"y":0,"width":30,"height":100}}}},
                 {{"width":1,"height":1,"transform":{{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0}},
                  "clip":{{"x":0,"y":0,"width":1,"height":1}}}}]"##,
            super::super::test_font::FAMILY
        ))
        .unwrap();
        let body = [1, 2, 3, 255, 5, 6, 7, 255, 9, 10, 11, 255];
        let layers = split_crop_layers(&meta, &body, &fonts, &EmojiFonts::empty()).unwrap();
        // The text arrives already clip-sized, at the clip's top-left.
        assert_eq!((layers[1].0.image.width, layers[1].0.image.height), (30, 100));
        assert_eq!((layers[1].0.transform.x, layers[1].0.transform.y), (0.0, 0.0));
        let out = crop(&layers).unwrap();
        assert_eq!(&out[..4], &[5, 6, 7, 255]);
        assert_eq!(&out[out.len() - 4..], &[9, 10, 11, 255]);
        assert_eq!(out.len(), 4 + 30 * 100 * 4 + 4);
        assert!(split_crop_layers(&meta, &body[..8], &fonts, &EmojiFonts::empty()).is_err());
    }

    #[test]
    fn crossing_text_matches_its_merge_rendering_and_crops_even_when_too_large_for_merge() {
        use super::super::text::{rasterise_placed, TextSpec};
        let fonts = super::super::test_font::database();
        let spec = TextSpec {
            text: "A".into(),
            font_family: super::super::test_font::FAMILY.into(),
            font_size: 100.0,
            color: "#0000ff".into(),
            outline: None,
        };
        // Rotated and scaled, hanging over the box's left and top edges.
        let t = LayerTransform { x: -20.3, y: -15.6, scale_x: 1.3, scale_y: 1.1, rotation: 20.0 };
        let reference = rasterise_placed(&fonts, &EmojiFonts::empty(), &spec, &t).unwrap();
        let clip = ClipRect { x: 0, y: 0, width: 40, height: 40 };
        let meta = [CropMeta {
            layer: LayerMeta { width: 60, height: 100, transform: t, text: Some(spec.clone()) },
            clip,
        }];
        let layers = split_crop_layers(&meta, &[], &fonts, &EmojiFonts::empty()).unwrap();
        let out = crop_layer(&layers[0].0, clip).unwrap();
        let (mut visible, mut flips) = (0, 0);
        for y in 0..40 {
            for x in 0..40 {
                let expected = merged_px(&reference, x as i32, y as i32);
                let got = px(&out, x, y);
                if got != expected {
                    assert!(got[3] == 0 || expected[3] == 0 || got[3].abs_diff(expected[3]) <= 2, "({x},{y}): {got:?} vs {expected:?}");
                    flips += 1;
                }
                visible += (expected[3] > 0) as u32;
            }
        }
        assert!(visible > 100, "the test must compare real pixels, saw {visible}");
        assert!(flips <= 4, "{flips} pixels differ from merge's rendering");
        // Scaled 100x the text is far too large for merge, yet a small clip crops.
        let huge = LayerTransform { x: -3000.0, y: -3000.0, scale_x: 100.0, scale_y: 100.0, rotation: 0.0 };
        assert!(rasterise_placed(&fonts, &EmojiFonts::empty(), &spec, &huge).unwrap_err().contains("too large"));
        let meta = [CropMeta { layer: LayerMeta { width: 60, height: 100, transform: huge, text: Some(spec) }, clip }];
        let layers = split_crop_layers(&meta, &[], &fonts, &EmojiFonts::empty()).unwrap();
        // Document (0, 0) is the glyph's (30, 30) at scale 1: inside 'A' (x 10..50, y 10..80).
        assert_eq!(px(&crop_layer(&layers[0].0, clip).unwrap(), 0, 0), [0, 0, 255, 255]);
    }

    #[test]
    fn a_crossing_outlined_text_crops_to_its_merge_rendering() {
        // SPM-18's fourth surface made explicit: an outlined text clipped
        // through the crop's window render matches its placed (merge)
        // rendering, ring included.
        use super::super::text::{rasterise_placed, OutlineSpec, TextSpec};
        let fonts = super::super::test_font::database();
        let spec = TextSpec {
            text: "A".into(),
            font_family: super::super::test_font::FAMILY.into(),
            font_size: 100.0,
            color: "#0000ff".into(),
            outline: Some(OutlineSpec { color: "#ff0000".into(), width: 2.0 }),
        };
        let t = LayerTransform { x: -20.3, y: -15.6, scale_x: 1.3, scale_y: 1.1, rotation: 20.0 };
        let reference = rasterise_placed(&fonts, &EmojiFonts::empty(), &spec, &t).unwrap();
        let clip = ClipRect { x: 0, y: 0, width: 40, height: 40 };
        let meta = [CropMeta {
            layer: LayerMeta { width: 64, height: 104, transform: t, text: Some(spec.clone()) },
            clip,
        }];
        let layers = split_crop_layers(&meta, &[], &fonts, &EmojiFonts::empty()).unwrap();
        let out = crop_layer(&layers[0].0, clip).unwrap();
        let (mut visible, mut flips) = (0, 0);
        for y in 0..40 {
            for x in 0..40 {
                let expected = merged_px(&reference, x as i32, y as i32);
                let got = px(&out, x, y);
                if got != expected {
                    // The ring's outer anti-aliased edge is the one place a
                    // whole-pixel window shift flips coverage, so a faint
                    // edge pixel may differ in alpha alone (16 vs 32 seen):
                    // what must never differ is a covered ring pixel.
                    assert!(got[3] == 0 || expected[3] == 0 || got[3].abs_diff(expected[3]) <= 32, "({x},{y}): {got:?} vs {expected:?}");
                    flips += 1;
                }
                visible += (expected[3] > 0) as u32;
            }
        }
        assert!(visible > 100, "the test must compare real pixels, saw {visible}");
        assert!(flips <= 4, "{flips} pixels differ from merge's rendering");
    }

    #[test]
    fn empty_or_oversized_clips_and_bad_transforms_are_refused() {
        let layer = placed(coords(2, 2), LayerTransform::IDENTITY);
        assert!(crop_layer(&layer, ClipRect { x: 0, y: 0, width: 0, height: 1 }).is_err());
        assert!(crop_layer(&layer, ClipRect { x: 0, y: 0, width: MAX_LAYER_SIDE + 1, height: 1 }).is_err());
        let nan = placed(coords(2, 2), LayerTransform { rotation: f32::NAN, ..LayerTransform::IDENTITY });
        assert!(crop_layer(&nan, ClipRect { x: 0, y: 0, width: 1, height: 1 }).is_err());
    }
}

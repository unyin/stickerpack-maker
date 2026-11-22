//! Save encoding (SPEC §6 Save, ADR-0005): the flattened image as PNG or
//! WEBP, held to a byte cap. PNG has no quality knob: it is encoded once, at
//! the best compression, and either fits or is too large (the webview then
//! offers WEBP, owner decision 2026-11-21). WEBP is tried lossless first,
//! then lossy with a quality search for the highest quality that fits; when
//! even the lowest quality is too large, the search is exhausted.

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use serde::{Deserialize, Serialize};

use super::Rgba;

/// A saved image's format; the extension of its file (ADR-0003).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SaveFormat {
    Png,
    Webp,
}

/// An encoding that fits the cap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Encoded {
    pub format: SaveFormat,
    pub bytes: Vec<u8>,
    /// The lossy WEBP quality used (0-100); None when lossless (PNG, or a
    /// lossless WEBP that fit).
    pub quality: Option<u8>,
}

/// The result of holding an image to a byte cap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeOutcome {
    Fits(Encoded),
    /// Nothing fit; `smallest` is the fewest bytes any attempt took.
    TooLarge { format: SaveFormat, smallest: usize },
}

/// Lossy WEBP qualities searched, lowest first.
const QUALITY_RANGE: std::ops::RangeInclusive<u8> = 0..=100;

/// Encode `image` as `format` in at most `max_bytes`.
pub fn encode_within(image: &Rgba, format: SaveFormat, max_bytes: usize) -> Result<EncodeOutcome, String> {
    check_pixels(image)?;
    match format {
        SaveFormat::Png => {
            let bytes = encode_png(image)?;
            Ok(if bytes.len() <= max_bytes {
                EncodeOutcome::Fits(Encoded { format, bytes, quality: None })
            } else {
                EncodeOutcome::TooLarge { format, smallest: bytes.len() }
            })
        }
        SaveFormat::Webp => {
            let lossless = encode_webp(image, None)?;
            if lossless.len() <= max_bytes {
                return Ok(EncodeOutcome::Fits(Encoded { format, bytes: lossless, quality: None }));
            }
            Ok(match search_quality(max_bytes, |q| encode_webp(image, Some(q)))? {
                Ok((quality, bytes)) => EncodeOutcome::Fits(Encoded { format, bytes, quality: Some(quality) }),
                Err(smallest) => EncodeOutcome::TooLarge { format, smallest: smallest.min(lossless.len()) },
            })
        }
    }
}

/// The highest quality whose encoding fits `max_bytes`, with its bytes, or
/// (`Err`) the size at the lowest quality when even that is too large. A
/// binary search: size grows with quality (nearly monotonically; a rare
/// non-monotonic step can only make it settle on a slightly lower quality,
/// never on one that does not fit).
fn search_quality(
    max_bytes: usize,
    mut encode: impl FnMut(u8) -> Result<Vec<u8>, String>,
) -> Result<Result<(u8, Vec<u8>), usize>, String> {
    let (mut lo, mut hi) = (*QUALITY_RANGE.start(), *QUALITY_RANGE.end());
    let lowest = encode(lo)?;
    if lowest.len() > max_bytes {
        return Ok(Err(lowest.len()));
    }
    // Invariant: `best` (quality `lo`) fits; every quality above `hi` is too large.
    let mut best = lowest;
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        let bytes = encode(mid)?;
        if bytes.len() <= max_bytes {
            lo = mid;
            best = bytes;
        } else {
            hi = mid - 1;
        }
    }
    Ok(Ok((lo, best)))
}

fn check_pixels(image: &Rgba) -> Result<(), String> {
    let expected = image.width as usize * image.height as usize * 4;
    if image.width == 0 || image.height == 0 || image.pixels.len() != expected {
        return Err(format!(
            "cannot encode a {}x{} image from {} bytes",
            image.width,
            image.height,
            image.pixels.len()
        ));
    }
    Ok(())
}

/// PNG at the best compression with adaptive row filters (straight RGBA8).
pub fn encode_png(image: &Rgba) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Best, FilterType::Adaptive)
        .write_image(&image.pixels, image.width, image.height, ExtendedColorType::Rgba8)
        .map_err(|e| format!("cannot encode the PNG: {e}"))?;
    Ok(out)
}

/// WEBP via libwebp: lossless when `quality` is None, else lossy at that
/// quality (0-100) with the alpha channel compressed losslessly.
pub fn encode_webp(image: &Rgba, quality: Option<u8>) -> Result<Vec<u8>, String> {
    let encoder = webp::Encoder::from_rgba(&image.pixels, image.width, image.height);
    let memory = match quality {
        None => encoder.encode_simple(true, 75.0),
        Some(q) => encoder.encode_simple(false, f32::from(q.min(*QUALITY_RANGE.end()))),
    }
    .map_err(|e| format!("cannot encode the WEBP: {e:?}"))?;
    Ok(memory.to_vec())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Deterministic noise with soft alpha: compresses badly, like a fuzzy
    /// glow's output would (CMT-141 note 4).
    pub(crate) fn noise(width: u32, height: u32) -> Rgba {
        let mut state = 0x2545_F491_u32;
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..width * height {
            for _ in 0..4 {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                pixels.push((state >> 24) as u8);
            }
        }
        Rgba { width, height, pixels }
    }

    fn flat(width: u32, height: u32) -> Rgba {
        Rgba { width, height, pixels: [200, 40, 90, 255].repeat((width * height) as usize) }
    }

    fn decode(bytes: &[u8]) -> image::RgbaImage {
        image::load_from_memory(bytes).unwrap().to_rgba8()
    }

    #[test]
    fn png_is_a_lossless_valid_png() {
        let img = noise(16, 9);
        let EncodeOutcome::Fits(out) = encode_within(&img, SaveFormat::Png, usize::MAX).unwrap() else { panic!() };
        assert!(out.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(out.quality, None);
        let back = decode(&out.bytes);
        assert_eq!((back.width(), back.height()), (16, 9));
        assert_eq!(back.into_raw(), img.pixels);
    }

    #[test]
    fn png_over_the_cap_is_too_large_with_its_size() {
        let img = noise(64, 64);
        let size = encode_png(&img).unwrap().len();
        assert_eq!(
            encode_within(&img, SaveFormat::Png, size - 1).unwrap(),
            EncodeOutcome::TooLarge { format: SaveFormat::Png, smallest: size }
        );
        assert!(matches!(encode_within(&img, SaveFormat::Png, size).unwrap(), EncodeOutcome::Fits(_)));
    }

    #[test]
    fn webp_that_fits_lossless_stays_lossless() {
        let img = flat(40, 30);
        let EncodeOutcome::Fits(out) = encode_within(&img, SaveFormat::Webp, usize::MAX).unwrap() else { panic!() };
        assert_eq!(&out.bytes[..4], b"RIFF");
        assert_eq!(&out.bytes[8..12], b"WEBP");
        assert_eq!(out.quality, None);
        assert_eq!(decode(&out.bytes).into_raw(), img.pixels);
    }

    #[test]
    fn a_high_entropy_sticker_fits_the_sticker_cap_only_as_lossy_webp() {
        // 512x512 soft-alpha noise: about 1 MB raw, too large as PNG for the
        // sticker cap; WEBP gets under it with a lossy quality.
        use crate::limits::{KB, STICKER_MAX_KB, STICKER_SIDE};
        let cap = (STICKER_MAX_KB * KB) as usize;
        let img = noise(STICKER_SIDE, STICKER_SIDE);
        assert!(matches!(encode_within(&img, SaveFormat::Png, cap).unwrap(), EncodeOutcome::TooLarge { .. }));
        let EncodeOutcome::Fits(out) = encode_within(&img, SaveFormat::Webp, cap).unwrap() else { panic!() };
        assert!(out.bytes.len() <= cap);
        assert!(out.quality.is_some());
        let back = decode(&out.bytes);
        assert_eq!((back.width(), back.height()), (STICKER_SIDE, STICKER_SIDE));
        // Lossy colour, lossless alpha: transparency survives exactly.
        let alpha: Vec<u8> = back.into_raw().chunks(4).map(|p| p[3]).collect();
        let original: Vec<u8> = img.pixels.chunks(4).map(|p| p[3]).collect();
        assert_eq!(alpha, original);
    }

    #[test]
    fn webp_too_large_even_at_the_lowest_quality_is_exhausted() {
        let img = noise(32, 32);
        let lowest = encode_webp(&img, Some(0)).unwrap().len();
        let EncodeOutcome::TooLarge { format, smallest } = encode_within(&img, SaveFormat::Webp, 10).unwrap() else {
            panic!()
        };
        assert_eq!(format, SaveFormat::Webp);
        assert!(smallest <= lowest && smallest > 10);
    }

    #[test]
    fn the_quality_search_finds_the_highest_quality_that_fits() {
        // A fake encoder whose size is 10 bytes per quality step.
        let mut calls = Vec::new();
        let found = search_quality(555, |q| {
            calls.push(q);
            Ok(vec![0; q as usize * 10])
        })
        .unwrap();
        assert_eq!(found.map(|(q, b)| (q, b.len())), Ok((55, 550)));
        assert!(calls.len() <= 9, "binary search, not a scan: {calls:?}");
        // Everything fits: the top quality.
        assert_eq!(search_quality(usize::MAX, |q| Ok(vec![0; q as usize])).unwrap().map(|(q, _)| q), Ok(100));
        // Nothing fits: the lowest quality's size.
        assert_eq!(search_quality(5, |q| Ok(vec![0; 10 + q as usize])).unwrap(), Err(10));
        // An encoder error is an error, not "too large".
        assert!(search_quality(5, |_| Err("boom".to_string())).is_err());
    }

    #[test]
    fn malformed_images_are_refused() {
        let bad = Rgba { width: 2, height: 2, pixels: vec![0; 15] };
        assert!(encode_within(&bad, SaveFormat::Png, usize::MAX).is_err());
        let empty = Rgba { width: 0, height: 0, pixels: vec![] };
        assert!(encode_within(&empty, SaveFormat::Webp, usize::MAX).is_err());
    }

    #[test]
    fn format_json_is_lowercase() {
        assert_eq!(serde_json::to_string(&SaveFormat::Webp).unwrap(), "\"webp\"");
        assert_eq!(serde_json::from_str::<SaveFormat>("\"png\"").unwrap(), SaveFormat::Png);
    }
}

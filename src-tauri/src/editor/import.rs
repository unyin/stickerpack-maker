//! Editor import pipeline (SPEC §6 "Import and canvas"): .jpg, .jpeg,
//! .jfif, .png, .webp; images larger than the import cap (`IMPORT_MAX_SIDE`
//! square) need the owner's OK to scale to fit (longest side at the cap,
//! aspect preserved) — Cancel aborts. Pasted clipboard images (SPM-9)
//! arrive as encoded bytes and follow the same rules.

use std::io::{BufRead, Cursor, Seek};
use std::path::Path;

use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageReader};

use super::{resize, Rgba};

pub use crate::limits::IMPORT_MAX_SIDE;

/// Extensions the Editor imports (case-insensitive). `.jfif` is JPEG.
pub const IMPORT_EXTENSIONS: [&str; 5] = ["jpg", "jpeg", "jfif", "png", "webp"];

/// Dimensions of an import candidate, read from its header only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    /// True when the image exceeds the import cap and needs the scale dialog.
    pub exceeds_cap: bool,
}

fn check_extension(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if IMPORT_EXTENSIONS.contains(&ext.as_str()) {
        Ok(())
    } else {
        Err(format!(
            "{} cannot be imported: the Editor opens .jpg, .jpeg, .jfif, .png and .webp files",
            path.display()
        ))
    }
}

/// A decoder chosen by the content (so `.jfif`, misnamed files and pasted
/// bytes decode as what they really are), with its EXIF orientation.
/// `what` names the source in errors.
fn decoder_for<'a, R: BufRead + Seek + 'a>(
    reader: ImageReader<R>,
    what: &str,
) -> Result<(impl ImageDecoder + 'a, Orientation), String> {
    let cannot = |e: &dyn std::fmt::Display| format!("cannot open {what}: {e}");
    let mut decoder = reader.with_guessed_format().map_err(|e| cannot(&e))?.into_decoder().map_err(|e| cannot(&e))?;
    // A missing or unreadable orientation tag means "as stored".
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    Ok((decoder, orientation))
}

fn open_decoder(path: &Path) -> Result<(impl ImageDecoder, Orientation), String> {
    check_extension(path)?;
    let what = path.display().to_string();
    let reader = ImageReader::open(path).map_err(|e| format!("cannot open {what}: {e}"))?;
    decoder_for(reader, &what)
}

/// What pasted images are called in errors.
const PASTED: &str = "the pasted image";

fn bytes_decoder(bytes: &[u8]) -> Result<(impl ImageDecoder + '_, Orientation), String> {
    decoder_for(ImageReader::new(Cursor::new(bytes)), PASTED)
}

/// True when an EXIF orientation turns the image on its side.
fn swaps_sides(orientation: Orientation) -> bool {
    matches!(
        orientation,
        Orientation::Rotate90 | Orientation::Rotate270 | Orientation::Rotate90FlipH | Orientation::Rotate270FlipH
    )
}

/// Read an import candidate's displayed size (EXIF orientation applied)
/// without decoding its pixels, so the UI can ask about the import cap first.
pub fn probe(path: &Path) -> Result<ImageInfo, String> {
    let (decoder, orientation) = open_decoder(path)?;
    Ok(info_of(&decoder, orientation))
}

/// `probe` for a pasted image's encoded bytes (PNG, JPEG or WEBP).
pub fn probe_bytes(bytes: &[u8]) -> Result<ImageInfo, String> {
    let (decoder, orientation) = bytes_decoder(bytes)?;
    Ok(info_of(&decoder, orientation))
}

fn info_of(decoder: &impl ImageDecoder, orientation: Orientation) -> ImageInfo {
    let (w, h) = decoder.dimensions();
    let (width, height) = if swaps_sides(orientation) { (h, w) } else { (w, h) };
    ImageInfo { width, height, exceeds_cap: width.max(height) > IMPORT_MAX_SIDE }
}

/// Size that fits within `max_side` x `max_side` with the aspect ratio
/// preserved: the longest side becomes `max_side`, the other rounds to the
/// nearest pixel (never below 1). Sizes already within the cap are kept.
pub fn fit_within(width: u32, height: u32, max_side: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_side {
        return (width, height);
    }
    let scale = |side: u32| ((side as f64 * max_side as f64 / longest as f64).round() as u32).max(1);
    (scale(width), scale(height))
}

/// Decode an image for the Editor: straight RGBA8, EXIF orientation
/// applied. An image over the import cap is refused unless `scale_to_fit` (the
/// owner pressed OK in the cap dialog), in which case it is resampled with
/// Lanczos3, alpha-aware so transparent edges keep their colour.
pub fn import(path: &Path, scale_to_fit: bool) -> Result<Rgba, String> {
    let (decoder, orientation) = open_decoder(path)?;
    decode(decoder, orientation, scale_to_fit, &path.display().to_string())
}

/// `import` for a pasted image's encoded bytes: the same import cap rule.
pub fn import_bytes(bytes: &[u8], scale_to_fit: bool) -> Result<Rgba, String> {
    let (decoder, orientation) = bytes_decoder(bytes)?;
    decode(decoder, orientation, scale_to_fit, PASTED)
}

fn decode(decoder: impl ImageDecoder, orientation: Orientation, scale_to_fit: bool, what: &str) -> Result<Rgba, String> {
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| format!("cannot decode {what}: {e}"))?;
    image.apply_orientation(orientation);
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    if width.max(height) <= IMPORT_MAX_SIDE {
        return Ok(Rgba { width, height, pixels: rgba.into_raw() });
    }
    if !scale_to_fit {
        return Err(format!(
            "{what} is {width}x{height}, larger than {IMPORT_MAX_SIDE}x{IMPORT_MAX_SIDE}; \
             it can only be imported scaled to fit"
        ));
    }
    resize(Rgba { width, height, pixels: rgba.into_raw() }, fit_within(width, height, IMPORT_MAX_SIDE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageEncoder, RgbaImage};
    use std::fs;
    use std::path::PathBuf;

    /// Write `img` in the format implied by `name`'s extension.
    fn write(dir: &Path, name: &str, img: &RgbaImage) -> PathBuf {
        let path = dir.join(name);
        let ext = name.rsplit('.').next().unwrap().to_ascii_lowercase();
        let mut bytes = Vec::new();
        match ext.as_str() {
            "png" => image::codecs::png::PngEncoder::new(&mut bytes)
                .write_image(img, img.width(), img.height(), image::ExtendedColorType::Rgba8)
                .unwrap(),
            "webp" => image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
                .write_image(img, img.width(), img.height(), image::ExtendedColorType::Rgba8)
                .unwrap(),
            // JPEG has no alpha: encode the RGB channels.
            _ => {
                let rgb = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();
                image::codecs::jpeg::JpegEncoder::new(&mut bytes)
                    .write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
                    .unwrap()
            }
        }
        fs::write(&path, bytes).unwrap();
        path
    }

    fn solid(width: u32, height: u32, px: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(width, height, image::Rgba(px))
    }

    #[test]
    fn all_five_formats_import_with_their_size() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.png", "b.webp", "c.jpg", "d.JPEG", "e.jfif"] {
            let path = write(dir.path(), name, &solid(30, 20, [200, 10, 10, 255]));
            let info = probe(&path).unwrap();
            assert_eq!((info.width, info.height, info.exceeds_cap), (30, 20, false), "{name}");
            let img = import(&path, false).unwrap();
            assert_eq!((img.width, img.height), (30, 20), "{name}");
            assert_eq!(img.pixels.len(), 30 * 20 * 4);
            // JPEG is lossy; colour lands close to the source.
            let [r, g, b, a] = [img.pixels[0], img.pixels[1], img.pixels[2], img.pixels[3]];
            assert!(r > 180 && g < 40 && b < 40 && a == 255, "{name}: {r},{g},{b},{a}");
        }
    }

    #[test]
    fn png_and_webp_keep_transparency() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["t.png", "t.webp"] {
            let path = write(dir.path(), name, &solid(4, 4, [0, 0, 255, 0]));
            assert_eq!(import(&path, false).unwrap().pixels[3], 0, "{name}");
        }
    }

    #[test]
    fn other_types_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let png = write(dir.path(), "x.png", &solid(2, 2, [0, 0, 0, 255]));
        for name in ["x.gif", "x.bmp", "x.tiff", "noext"] {
            let path = dir.path().join(name);
            fs::copy(&png, &path).unwrap();
            assert!(probe(&path).is_err(), "probe accepted {name}");
            assert!(import(&path, false).is_err(), "import accepted {name}");
        }
        assert!(probe(&dir.path().join("absent.png")).is_err());
        let garbage = dir.path().join("garbage.png");
        fs::write(&garbage, b"not an image").unwrap();
        assert!(import(&garbage, false).is_err());
    }

    #[test]
    fn content_decides_the_decoder_not_the_extension() {
        // A PNG saved as .jpg still opens (the Editor is lenient on import;
        // saves are validated strictly in SPM-10).
        let dir = tempfile::tempdir().unwrap();
        let png = write(dir.path(), "real.png", &solid(3, 3, [1, 2, 3, 0]));
        let renamed = dir.path().join("renamed.jpg");
        fs::copy(&png, &renamed).unwrap();
        assert_eq!(import(&renamed, false).unwrap().pixels[3], 0);
    }

    #[test]
    fn exif_orientation_is_applied_so_photos_are_not_sideways() {
        // A 30x20 JPEG tagged "rotate 90" (EXIF orientation 6), as phones
        // write: it must import as 20x30.
        let dir = tempfile::tempdir().unwrap();
        let plain = write(dir.path(), "plain.jpg", &solid(30, 20, [10, 200, 10, 255]));
        let jpeg = fs::read(&plain).unwrap();
        let tiff: [u8; 26] = [
            b'I', b'I', 42, 0, 8, 0, 0, 0, // little-endian TIFF header, IFD at 8
            1, 0, // one entry
            0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, // Orientation (SHORT) = 6
            0, 0, 0, 0, // no next IFD
        ];
        let mut app1 = vec![0xFF, 0xE1, 0, 34];
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&tiff);
        let mut tagged = jpeg[..2].to_vec(); // SOI
        tagged.extend_from_slice(&app1);
        tagged.extend_from_slice(&jpeg[2..]);
        let path = dir.path().join("rotated.jpg");
        fs::write(&path, tagged).unwrap();
        let info = probe(&path).unwrap();
        assert_eq!((info.width, info.height), (20, 30));
        let img = import(&path, false).unwrap();
        assert_eq!((img.width, img.height), (20, 30));
    }

    #[test]
    fn pasted_bytes_follow_the_same_rules_as_files() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["p.png", "p.webp", "p.jpg"] {
            let bytes = fs::read(write(dir.path(), name, &solid(30, 20, [200, 10, 10, 255]))).unwrap();
            let info = probe_bytes(&bytes).unwrap();
            assert_eq!((info.width, info.height, info.exceeds_cap), (30, 20, false), "{name}");
            let img = import_bytes(&bytes, false).unwrap();
            assert_eq!((img.width, img.height), (30, 20), "{name}");
        }
        let cap = IMPORT_MAX_SIDE;
        let big = fs::read(write(dir.path(), "big.png", &solid(cap + 10, 4, [0, 0, 0, 255]))).unwrap();
        assert!(probe_bytes(&big).unwrap().exceeds_cap);
        assert!(import_bytes(&big, false).unwrap_err().contains("pasted image"));
        assert_eq!(import_bytes(&big, true).unwrap().width, cap);
        assert!(probe_bytes(b"not an image").is_err());
        assert!(import_bytes(b"GIF89a....", false).is_err());
    }

    #[test]
    fn fit_within_keeps_aspect_with_longest_side_at_max_side() {
        // Any max side works; 100 keeps the arithmetic readable.
        assert_eq!(fit_within(400, 300, 100), (100, 75));
        assert_eq!(fit_within(300, 400, 100), (75, 100));
        assert_eq!(fit_within(101, 101, 100), (100, 100));
        assert_eq!(fit_within(5000, 1, 100), (100, 1), "never rounds to zero");
        assert_eq!(fit_within(99, 3, 100), (99, 3), "within max side: unchanged");
    }

    #[test]
    fn oversize_import_needs_the_owners_ok_to_scale() {
        let dir = tempfile::tempdir().unwrap();
        let cap = IMPORT_MAX_SIDE;
        let path = write(dir.path(), "big.png", &solid(cap * 2, 10, [0, 128, 0, 255]));
        let info = probe(&path).unwrap();
        assert!(info.exceeds_cap);
        let err = import(&path, false).unwrap_err();
        assert!(err.contains(&cap.to_string()), "unexpected error: {err}");
        let fitted = import(&path, true).unwrap();
        assert_eq!((fitted.width, fitted.height), fit_within(cap * 2, 10, cap));
        assert_eq!(fitted.width, cap);
        // Exactly the cap on one side is within it.
        let edge = write(dir.path(), "edge.png", &solid(cap, 10, [0, 0, 0, 255]));
        assert!(!probe(&edge).unwrap().exceeds_cap);
        assert_eq!(import(&edge, false).unwrap().width, cap);
    }

    #[test]
    fn scaling_does_not_darken_transparent_edges() {
        // Left half opaque red, right half fully transparent black: naive
        // (non-premultiplied) resampling bleeds black into the edge.
        let dir = tempfile::tempdir().unwrap();
        // Twice the cap wide, so the import must scale it down.
        let mut img = solid(IMPORT_MAX_SIDE * 2, 100, [0, 0, 0, 0]);
        for x in 0..IMPORT_MAX_SIDE {
            for y in 0..100 {
                img.put_pixel(x, y, image::Rgba([255, 0, 0, 255]));
            }
        }
        let path = write(dir.path(), "edge.png", &img);
        let fitted = import(&path, true).unwrap();
        let row = 25 * fitted.width as usize * 4;
        for x in 0..fitted.width as usize {
            let px = &fitted.pixels[row + x * 4..row + x * 4 + 4];
            if px[3] > 0 {
                assert!(px[0] > 200, "darkened edge at x={x}: {px:?}");
            }
        }
    }
}

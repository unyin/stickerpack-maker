//! Test fixtures: real, tiny PNG/WEBP images that pass sticker validation
//! (header dimensions included), each carrying a text tag after the image
//! data so tests can tell files apart after renames.

use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{ExtendedColorType, ImageEncoder};

use crate::limits::STICKER_SIDE;

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
const PNG_END: &[u8] = b"IEND";

fn pixels(width: u32, height: u32) -> Vec<u8> {
    vec![0x7f; (width * height * 4) as usize]
}

/// A real `width`×`height` PNG with `tag` appended after its IEND chunk.
pub fn png_sized(width: u32, height: u32, tag: &str) -> Vec<u8> {
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(&pixels(width, height), width, height, ExtendedColorType::Rgba8)
        .unwrap();
    out.extend_from_slice(tag.as_bytes());
    out
}

/// A real `width`×`height` lossless WEBP with `tag` appended after its RIFF chunk.
pub fn webp_sized(width: u32, height: u32, tag: &str) -> Vec<u8> {
    let mut out = Vec::new();
    WebPEncoder::new_lossless(&mut out)
        .write_image(&pixels(width, height), width, height, ExtendedColorType::Rgba8)
        .unwrap();
    out.extend_from_slice(tag.as_bytes());
    out
}

/// A valid sticker PNG (`STICKER_SIDE`×1) tagged `tag`.
pub fn png(tag: &str) -> Vec<u8> {
    png_sized(STICKER_SIDE, 1, tag)
}

/// A valid sticker WEBP (`STICKER_SIDE`×1) tagged `tag`.
pub fn webp(tag: &str) -> Vec<u8> {
    webp_sized(STICKER_SIDE, 1, tag)
}

/// The tag written after a fixture's image data.
pub fn tag_of(bytes: &[u8]) -> String {
    let end = if bytes.starts_with(PNG_MAGIC) {
        // IEND chunk: type (4 bytes) then CRC (4 bytes); no data.
        let at = bytes.windows(PNG_END.len()).rposition(|w| w == PNG_END).expect("no IEND chunk");
        at + PNG_END.len() + 4
    } else {
        assert_eq!(&bytes[..4], b"RIFF", "not a fixture image");
        let size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        8 + size + size % 2
    };
    String::from_utf8(bytes[end..].to_vec()).unwrap()
}

#[test]
fn fixtures_pass_validation_and_keep_their_tags() {
    let dir = tempfile::tempdir().unwrap();
    for (name, bytes) in [("a.png", png("hello")), ("b.webp", webp("world"))] {
        let path = dir.path().join(name);
        std::fs::write(&path, &bytes).unwrap();
        super::stickers::validate_sticker_file(&path).unwrap();
        assert_eq!(super::stickers::image_dimensions(&path).unwrap(), (STICKER_SIDE, 1));
    }
    assert_eq!(tag_of(&png("hello")), "hello");
    assert_eq!(tag_of(&webp("world")), "world");
}

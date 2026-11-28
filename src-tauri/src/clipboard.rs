//! The image clipboard (SPM-67): the pure half of the clipboard commands,
//! Tauri-free and unit-tested like the editor code (ADR-0005). The commands
//! that touch the OS clipboard are `clipboard_commands`.
//!
//! Pixels cross the Tauri boundary as raw bytes, never JSON (ADR-0005): a set
//! request's body is the binary frame every pixel command shares — u32 LE
//! width, u32 LE height, then straight RGBA8 — and a get response is that same
//! frame (`Rgba::to_frame`). This module only parses and validates a frame and
//! converts the clipboard's `ImageData` back into the repo's `Rgba`; it never
//! opens a clipboard, so its tests run on a machine with no display server.

use arboard::ImageData;

use crate::editor::Rgba;

/// Bytes of a frame's header: u32 LE width, then u32 LE height.
pub const FRAME_HEADER_LEN: usize = 8;

/// The RGBA byte count for a `width`x`height` image, checked: no zero side,
/// and the multiplication must not overflow (both values can come from
/// another app's clipboard data).
fn rgba_len(width: u32, height: u32) -> Result<usize, String> {
    if width == 0 || height == 0 {
        return Err(format!("the image is {width}x{height}, so one side is empty"));
    }
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| format!("the image is {width}x{height}, whose RGBA size overflows"))
}

/// A set request's frame as `(width, height, the width * height * 4 RGBA
/// bytes)`. The pixels are borrowed from the body rather than copied: the
/// largest image the Editor sends is 16 MB, and it goes straight on to the
/// clipboard. The frame must hold exactly its own size — no short and no
/// extra bytes.
pub fn split_frame(frame: &[u8]) -> Result<(u32, u32, &[u8]), String> {
    if frame.len() < FRAME_HEADER_LEN {
        return Err(format!(
            "the image frame is {} bytes, too short for its {FRAME_HEADER_LEN}-byte header",
            frame.len()
        ));
    }
    let (header, pixels) = frame.split_at(FRAME_HEADER_LEN);
    let width = u32::from_le_bytes(header[0..4].try_into().expect("a 4-byte slice"));
    let height = u32::from_le_bytes(header[4..8].try_into().expect("a 4-byte slice"));
    let expected = rgba_len(width, height)?;
    if pixels.len() != expected {
        return Err(format!(
            "the image frame carries {} bytes after its header, expected {expected} for {width}x{height}",
            pixels.len()
        ));
    }
    Ok((width, height, pixels))
}

/// The clipboard's image as the repo's `Rgba`, ready for `to_frame`. arboard
/// returns straight RGBA8 for the formats the app writes (PNG, CF_DIBV5), but
/// its size fields are `usize` and describe another app's data, so they are
/// checked like a request's before they reach the frame.
pub fn to_rgba(image: &ImageData<'_>) -> Result<Rgba, String> {
    let too_big = |px: usize| format!("the clipboard image's {px} px does not fit in a frame");
    let width = u32::try_from(image.width).map_err(|_| too_big(image.width))?;
    let height = u32::try_from(image.height).map_err(|_| too_big(image.height))?;
    let expected = rgba_len(width, height)?;
    if image.bytes.len() != expected {
        return Err(format!(
            "the clipboard image is {width}x{height} but has {} bytes, expected {expected}",
            image.bytes.len()
        ));
    }
    Ok(Rgba { width, height, pixels: image.bytes.to_vec() })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `width`x`height` frame whose every byte is its own index, so a copied
    /// or shifted pixel shows up.
    fn frame(width: u32, height: u32) -> Vec<u8> {
        let mut frame = Vec::new();
        frame.extend_from_slice(&width.to_le_bytes());
        frame.extend_from_slice(&height.to_le_bytes());
        let len = (width as usize) * (height as usize) * 4;
        frame.extend((0..len).map(|i| i as u8));
        frame
    }

    #[test]
    fn split_frame_returns_the_size_and_the_pixels() {
        let bytes = frame(2, 1);
        let (width, height, pixels) = split_frame(&bytes).unwrap();
        assert_eq!((width, height), (2, 1));
        assert_eq!(pixels, &[0, 1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn split_frame_borrows_the_pixels_out_of_the_body() {
        let bytes = frame(3, 2);
        let (_, _, pixels) = split_frame(&bytes).unwrap();
        assert_eq!(pixels.as_ptr(), bytes[FRAME_HEADER_LEN..].as_ptr());
    }

    #[test]
    fn split_frame_refuses_a_short_body() {
        let mut short = frame(2, 2);
        short.truncate(8 + 15);
        assert!(split_frame(&short).unwrap_err().contains("expected 16 for 2x2"));
    }

    #[test]
    fn split_frame_refuses_extra_bytes() {
        let mut long = frame(2, 2);
        long.push(0);
        assert!(split_frame(&long).unwrap_err().contains("expected 16 for 2x2"));
    }

    #[test]
    fn split_frame_refuses_a_body_shorter_than_the_header() {
        assert!(split_frame(&[2, 0, 0, 0]).unwrap_err().contains("too short"));
        assert!(split_frame(&[]).unwrap_err().contains("too short"));
    }

    #[test]
    fn split_frame_refuses_an_empty_side() {
        assert!(split_frame(&frame(0, 2)).unwrap_err().contains("0x2, so one side is empty"));
        assert!(split_frame(&frame(2, 0)).unwrap_err().contains("2x0, so one side is empty"));
    }

    #[test]
    fn split_frame_refuses_a_size_whose_rgba_overflows() {
        let mut huge = Vec::new();
        huge.extend_from_slice(&u32::MAX.to_le_bytes());
        huge.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(split_frame(&huge).unwrap_err().contains("overflows"));
    }

    #[test]
    fn to_rgba_is_the_clipboards_size_and_bytes() {
        let bytes = [1, 2, 3, 4, 5, 6, 7, 8];
        let image = ImageData { width: 2, height: 1, bytes: bytes[..].into() };
        assert_eq!(
            to_rgba(&image).unwrap(),
            Rgba { width: 2, height: 1, pixels: bytes.to_vec() }
        );
    }

    #[test]
    fn to_rgba_round_trips_into_the_frame_that_set_parses() {
        let body = frame(3, 2);
        let image = ImageData { width: 3, height: 2, bytes: body[FRAME_HEADER_LEN..].into() };
        let rgba = to_rgba(&image).unwrap();
        assert_eq!(split_frame(&rgba.to_frame()).unwrap(), (3, 2, &rgba.pixels[..]));
    }

    #[test]
    fn to_rgba_refuses_bytes_that_do_not_match_the_size() {
        let image = ImageData { width: 2, height: 2, bytes: vec![0; 15].into() };
        assert!(to_rgba(&image).unwrap_err().contains("but has 15 bytes, expected 16"));
    }

    #[test]
    fn to_rgba_refuses_an_empty_side() {
        let image = ImageData { width: 0, height: 4, bytes: Vec::new().into() };
        assert!(to_rgba(&image).unwrap_err().contains("0x4, so one side is empty"));
    }

    /// A `usize` wider than u32 can only happen on a 64-bit build, which is
    /// every build the app ships.
    #[cfg(target_pointer_width = "64")]
    #[test]
    fn to_rgba_refuses_a_side_beyond_the_frame_header() {
        for (width, height) in [(u32::MAX as usize + 1, 1), (1, u32::MAX as usize + 1)] {
            let image = ImageData { width, height, bytes: Vec::new().into() };
            assert!(to_rgba(&image).unwrap_err().contains("does not fit in a frame"));
        }
    }
}

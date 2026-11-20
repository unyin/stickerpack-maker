//! Editor pixel work in Rust (ADR-0005): one-shot operations on RGBA
//! buffers — import decoding, resizing, and (later tasks) merge, effects,
//! text rasterising and encoding. Tauri-free so it is unit-testable; the
//! interactive model, history and live brushes live in the webview.

pub mod import;
pub mod merge;

use fast_image_resize::images::Image as FirImage;
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};

/// A straight (non-premultiplied) RGBA8 image, row-major, 4 bytes per pixel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Rgba {
    /// Binary IPC frame for the webview: u32 LE width, u32 LE height, then
    /// the RGBA bytes (raw, never JSON — a 2000x2000 image is 16 MB).
    pub fn to_frame(&self) -> Vec<u8> {
        let mut frame = Vec::with_capacity(8 + self.pixels.len());
        frame.extend_from_slice(&self.width.to_le_bytes());
        frame.extend_from_slice(&self.height.to_le_bytes());
        frame.extend_from_slice(&self.pixels);
        frame
    }
}

/// Resample to `(width, height)` with Lanczos3: the 2000 cap on import and
/// shrinking layers before compositing. fast_image_resize premultiplies
/// alpha around the convolution, so transparent edges keep their colour.
pub(crate) fn resize(src: Rgba, (width, height): (u32, u32)) -> Result<Rgba, String> {
    let failed = |e: &dyn std::fmt::Display| format!("cannot resize image: {e}");
    let src_view = FirImage::from_vec_u8(src.width, src.height, src.pixels, PixelType::U8x4)
        .map_err(|e| failed(&e))?;
    let mut dst = FirImage::new(width, height, PixelType::U8x4);
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    Resizer::new()
        .resize(&src_view, &mut dst, &options)
        .map_err(|e| failed(&e))?;
    Ok(Rgba { width, height, pixels: dst.into_vec() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_little_endian_header_then_pixels() {
        let img = Rgba { width: 2, height: 1, pixels: vec![1, 2, 3, 4, 5, 6, 7, 8] };
        assert_eq!(img.to_frame(), vec![2, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }
}

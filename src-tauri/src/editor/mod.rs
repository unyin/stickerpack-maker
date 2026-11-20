//! Editor pixel work in Rust (ADR-0005): one-shot operations on RGBA
//! buffers — import decoding, resizing, and (later tasks) merge, effects,
//! text rasterising and encoding. Tauri-free so it is unit-testable; the
//! interactive model, history and live brushes live in the webview.

pub mod import;
pub mod merge;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_little_endian_header_then_pixels() {
        let img = Rgba { width: 2, height: 1, pixels: vec![1, 2, 3, 4, 5, 6, 7, 8] };
        assert_eq!(img.to_frame(), vec![2, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }
}

//! The background removal model (ADR-0006): every fact about it in one
//! constant, so swapping it for another of the same family is a
//! one-constant change.

/// What the app needs to know about a segmentation model.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelSpec {
    /// File name in the model cache (`<app data>/models/`).
    pub file_name: &'static str,
    /// Where the one-time download comes from (HTTPS; redirects are followed).
    pub url: &'static str,
    /// SHA-256 of the file, lowercase hex: a download or cached file that
    /// does not match is deleted, never run.
    pub sha256: &'static str,
    /// Exact size of the file in bytes (shown before the download, and checked).
    pub size_bytes: u64,
    /// The model's square input side in px.
    pub input_side: u32,
    /// Per-channel (R, G, B) normalisation after scaling to 0-1: (x - mean) / std.
    pub mean: [f32; 3],
    pub std: [f32; 3],
}

/// ISNet general use (DIS, Apache-2.0), as rembg publishes it: 1024×1024
/// input, mean 0.5 and std 1 (rembg's `dis_general_use` session).
pub const ISNET_GENERAL_USE: ModelSpec = ModelSpec {
    file_name: "isnet-general-use.onnx",
    // The project's own release asset (SPM-19), a byte-identical mirror of
    // rembg's release asset: same SHA-256 and size, so only the URL moved.
    url: "https://github.com/unyin/stickerpack-maker/releases/download/models/isnet-general-use.onnx",
    sha256: "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a",
    size_bytes: 178_648_008,
    input_side: 1024,
    mean: [0.5, 0.5, 0.5],
    std: [1.0, 1.0, 1.0],
};

/// The model background removal uses (owner decision, 2026-11-23: the only
/// one; the anime model was dropped after the owner's Windows test).
pub const MODEL: ModelSpec = ISNET_GENERAL_USE;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_is_pinned_by_lowercase_sha256_hex() {
        assert_eq!(MODEL.sha256.len(), 64);
        assert!(MODEL.sha256.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert!(MODEL.url.starts_with("https://") && MODEL.url.ends_with(MODEL.file_name));
        assert!(MODEL.input_side > 0 && MODEL.std.iter().all(|s| *s > 0.0));
    }
}

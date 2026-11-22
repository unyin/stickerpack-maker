//! The background removal models (ADR-0006): every fact about each in one
//! constant, so adding or swapping a model of the same family is a
//! one-constant change. The Editor offers every model in `MODELS`, by id.

/// What the app needs to know about a segmentation model.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelSpec {
    /// The id the webview names the model by.
    pub id: &'static str,
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
    id: "isnet-general-use",
    file_name: "isnet-general-use.onnx",
    url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx",
    sha256: "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a",
    size_bytes: 178_648_008,
    input_side: 1024,
    mean: [0.5, 0.5, 0.5],
    std: [1.0, 1.0, 1.0],
};

/// ISNet fine-tuned for anime characters (SkyTNT's anime-segmentation,
/// Apache-2.0), as rembg publishes it: 1024×1024 input, ImageNet mean and
/// std 1 (rembg's `dis_anime` session).
pub const ISNET_ANIME: ModelSpec = ModelSpec {
    id: "isnet-anime",
    file_name: "isnet-anime.onnx",
    url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-anime.onnx",
    sha256: "f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99",
    size_bytes: 176_069_933,
    input_side: 1024,
    mean: [0.485, 0.456, 0.406],
    std: [1.0, 1.0, 1.0],
};

/// The models the Editor offers; the first is the default.
pub const MODELS: [ModelSpec; 2] = [ISNET_GENERAL_USE, ISNET_ANIME];

/// The default model (general subjects); the webview's list starts with it too.
#[cfg(test)]
pub const DEFAULT_MODEL: ModelSpec = MODELS[0];

/// The model the webview names by `id`.
pub fn model_by_id(id: &str) -> Result<&'static ModelSpec, String> {
    MODELS.iter().find(|m| m.id == id).ok_or_else(|| format!("there is no background removal model named {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_model_is_pinned_by_lowercase_sha256_hex() {
        for m in MODELS {
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m.sha256.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)), "{}", m.id);
            assert!(m.url.starts_with("https://") && m.url.ends_with(m.file_name), "{}", m.id);
            assert!(m.input_side > 0 && m.std.iter().all(|s| *s > 0.0), "{}", m.id);
        }
    }

    #[test]
    fn models_have_distinct_ids_and_cache_files() {
        for (i, a) in MODELS.iter().enumerate() {
            for b in &MODELS[i + 1..] {
                assert_ne!(a.id, b.id);
                assert_ne!(a.file_name, b.file_name);
            }
        }
        // The webview's BACKGROUND_MODELS (src/editor/api.ts) lists these ids in this order.
        assert_eq!(MODELS.map(|m| m.id), ["isnet-general-use", "isnet-anime"]);
        assert_eq!(DEFAULT_MODEL.id, "isnet-general-use");
    }

    #[test]
    fn models_are_found_by_id() {
        assert_eq!(model_by_id("isnet-anime").unwrap().file_name, "isnet-anime.onnx");
        assert!(model_by_id("rmbg").is_err());
    }
}

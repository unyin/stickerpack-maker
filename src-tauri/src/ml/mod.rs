//! Background removal (SPM-7, ADR-0006): a segmentation model on ONNX
//! Runtime (`ort`, statically linked) turns an image layer into an alpha
//! mask. The model (model.rs) is downloaded once on its first use, checked
//! against its pinned SHA-256 and cached under the app data folder; after
//! that removal is fully offline. Tauri-free: commands.rs wires it to
//! the webview.

pub mod download;
pub mod matting;
pub mod model;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;

use crate::editor::Rgba;
pub use download::DownloadOutcome;
use model::ModelSpec;

/// Whether the model is in the cache, for the first-use download question.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub downloaded: bool,
    /// The download's size, shown in the question.
    pub size_bytes: u64,
}

/// What the Editor says when removal is asked for before the download. Unlike the
/// crate's lowercase internal error fragments, this and `NOTHING_FOUND` are full
/// sentences shown as-is in the Editor's message line.
pub const NOT_DOWNLOADED: &str = "The background removal model has not been downloaded yet.";

/// What the Editor says when the model finds nothing to keep.
pub const NOTHING_FOUND: &str =
    "No subject was found in this layer, so nothing was removed. Use the Erase brush to remove the background by hand.";

/// The model, its cache and the loaded session: one per app (Tauri state).
pub struct BackgroundRemover {
    cache_dir: PathBuf,
    spec: ModelSpec,
    /// The model's loaded session, loaded on the first removal in each run
    /// after its hash is checked. It holds about the model file's size in
    /// memory.
    session: Mutex<Option<Session>>,
    /// One download at a time.
    downloading: Mutex<()>,
    cancel: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic mid-inference leaves nothing half-written worth refusing over.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl BackgroundRemover {
    pub fn new(cache_dir: PathBuf, spec: ModelSpec) -> Self {
        Self { cache_dir, spec, session: Mutex::new(None), downloading: Mutex::new(()), cancel: AtomicBool::new(false) }
    }

    pub fn status(&self) -> ModelStatus {
        ModelStatus { downloaded: download::is_cached(&self.cache_dir, &self.spec), size_bytes: self.spec.size_bytes }
    }

    /// The pinned download size, for progress totals: unlike `status()`,
    /// this touches no filesystem.
    pub fn size_bytes(&self) -> u64 {
        self.spec.size_bytes
    }

    /// Download the model unless it is already cached. `progress` gets the
    /// bytes received so far, starting with 0 once the download has begun:
    /// the cancel flag is cleared just before that first report, so the
    /// Editor offers Cancel download only from then on, and a Cancel pressed
    /// after an earlier download ended never stops the next one.
    pub fn download(&self, progress: &mut dyn FnMut(u64)) -> Result<DownloadOutcome, String> {
        let _one_at_a_time = lock(&self.downloading);
        self.cancel.store(false, Ordering::Relaxed);
        if download::is_cached(&self.cache_dir, &self.spec) {
            return Ok(DownloadOutcome::Done);
        }
        progress(0);
        download::download(&self.cache_dir, &self.spec, progress, &self.cancel)
    }

    /// Stop the download in progress (it ends as `Cancelled`); a cancel
    /// before a download begins is cleared when it begins.
    pub fn cancel_download(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// The layer with its background made transparent (alpha multiplied by
    /// the model's mask; colours unchanged).
    pub fn remove(&self, image: &Rgba) -> Result<Rgba, String> {
        let mut loaded = lock(&self.session);
        if loaded.is_none() {
            *loaded = Some(self.load()?);
        }
        let session = loaded.as_mut().expect("loaded above");
        let mask = run_model(session, image, &self.spec)?;
        let out = matting::apply_mask(image, &mask)?;
        if !matting::has_visible_pixels(&out) {
            return Err(NOTHING_FOUND.into());
        }
        Ok(out)
    }

    fn load(&self) -> Result<Session, String> {
        if !download::is_cached(&self.cache_dir, &self.spec) {
            return Err(NOT_DOWNLOADED.into());
        }
        let path = download::model_path(&self.cache_dir, &self.spec);
        download::verify_file(&path, &self.spec)?;
        load_session(&path)
    }
}

/// The layer a removal request carries: its size (header) and raw RGBA bytes (body).
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct LayerSize {
    pub width: u32,
    pub height: u32,
}

impl LayerSize {
    /// The layer from the request's body, which must be exactly its size in RGBA bytes.
    pub fn decode(self, body: &[u8]) -> Result<Rgba, String> {
        let expected = self.width as usize * self.height as usize * 4;
        if self.width == 0 || self.height == 0 || body.len() != expected {
            return Err(format!(
                "the layer has {} bytes, expected {expected} for {}x{}",
                body.len(),
                self.width,
                self.height
            ));
        }
        Ok(Rgba { width: self.width, height: self.height, pixels: body.to_vec() })
    }
}

/// The process's one ONNX Runtime environment: ONNX Runtime allows only one
/// per process, and every session (each load, each reload) shares it.
fn environment() -> Result<&'static ort::environment::Environment, String> {
    static ENVIRONMENT: OnceLock<ort::environment::Environment> = OnceLock::new();
    if let Some(environment) = ENVIRONMENT.get() {
        return Ok(environment);
    }
    let built = ort::init()
        .with_name("stickerpack-maker")
        .build()
        .map_err(|e| format!("cannot start ONNX Runtime: {e}"))?;
    // Sessions load under the remover's lock, so no other thread builds one meanwhile.
    Ok(ENVIRONMENT.get_or_init(|| built))
}

/// Load a model into ONNX Runtime (CPU, all cores, full graph optimisation).
/// Called only under the remover's session lock, which keeps `environment()`
/// from being built twice at once.
fn load_session(path: &Path) -> Result<Session, String> {
    let failed = |e: &dyn std::fmt::Display| format!("cannot load the background removal model: {e}");
    Session::builder(environment()?)
        .map_err(|e| failed(&e))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| failed(&e))?
        .commit_from_file(path)
        .map_err(|e| failed(&e))
}

/// Run the model on a layer: its alpha mask at the layer's size.
pub fn run_model(session: &mut Session, image: &Rgba, spec: &ModelSpec) -> Result<Vec<u8>, String> {
    let failed = |e: &dyn std::fmt::Display| format!("background removal failed: {e}");
    let side = spec.input_side as usize;
    let input = matting::model_input(image, spec)?;
    let tensor = Tensor::from_array(([1usize, 3, side, side], input.into_boxed_slice())).map_err(|e| failed(&e))?;
    let outputs = session.run(ort::inputs![tensor]).map_err(|e| failed(&e))?;
    // ISNet's first output is the finest map, 1×1×side×side.
    let (_, prediction) = outputs[0].try_extract_tensor::<f32>().map_err(|e| failed(&e))?;
    let mask = matting::mask_from_output(prediction, spec.input_side)?;
    matting::resize_mask(mask, spec.input_side, (image.width, image.height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removal_before_the_download_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let remover = BackgroundRemover::new(dir.path().to_path_buf(), model::MODEL);
        let image = Rgba { width: 1, height: 1, pixels: vec![0, 0, 0, 255] };
        let status = remover.status();
        assert!(!status.downloaded);
        assert_eq!(status.size_bytes, model::MODEL.size_bytes);
        assert_eq!(remover.remove(&image), Err(NOT_DOWNLOADED.to_string()));
    }

    #[test]
    fn a_stale_cancel_is_cleared_when_a_download_begins() {
        let dir = tempfile::tempdir().unwrap();
        let spec = ModelSpec { file_name: "model.onnx", size_bytes: 4, ..model::MODEL };
        let path = download::model_path(dir.path(), &spec);
        std::fs::write(&path, [1, 2, 3, 4]).unwrap();
        let remover = BackgroundRemover::new(dir.path().to_path_buf(), spec);
        remover.cancel_download(); // pressed after an earlier download ended
        let mut reports = Vec::new();
        assert_eq!(remover.download(&mut |n| reports.push(n)), Ok(DownloadOutcome::Done));
        assert!(!remover.cancel.load(Ordering::Relaxed), "cleared when the download began");
        assert!(reports.is_empty(), "a cached model reports no progress");
    }

    #[test]
    fn a_layer_body_must_match_its_size() {
        let size: LayerSize = serde_json::from_str(r#"{"width":2,"height":1}"#).unwrap();
        assert_eq!(size.decode(&[1, 2, 3, 4, 5, 6, 7, 8]).unwrap().pixels, vec![1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(size.decode(&[0; 7]).is_err());
        assert!(LayerSize { width: 0, height: 0 }.decode(&[]).is_err());
    }

    #[test]
    fn status_serializes_camel_case_for_the_webview() {
        let json = serde_json::to_value(ModelStatus { downloaded: true, size_bytes: 5 }).unwrap();
        assert_eq!(json, serde_json::json!({ "downloaded": true, "sizeBytes": 5 }));
        assert_eq!(serde_json::to_value(DownloadOutcome::Cancelled).unwrap(), "cancelled");
    }

    /// Where the ignored real-model test keeps the model: `SPM_MODEL_DIR`,
    /// else `target/test-models`.
    fn test_model_dir() -> PathBuf {
        std::env::var_os("SPM_MODEL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-models"))
    }

    /// A cartoon-like face (a flat disc with a dark outline and two eyes) on
    /// a white background: the model must keep the face and drop the corners
    /// (it is downloaded into `SPM_MODEL_DIR`, default `target/test-models`,
    /// on the first run; ~179 MB).
    #[test]
    #[ignore = "downloads and runs the real background removal model"]
    fn the_real_model_keeps_a_subject_and_drops_a_plain_background() {
        let dir = test_model_dir();
        let remover = BackgroundRemover::new(dir, model::MODEL);
        let (width, height) = (300u32, 200u32);
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let (dx, dy) = (x as f32 - 150.0, y as f32 - 100.0);
                let r = (dx * dx + dy * dy).sqrt();
                let eye = |ex: f32| ((x as f32 - ex).powi(2) + (y as f32 - 85.0).powi(2)).sqrt() < 7.0;
                let px: [u8; 4] = if r < 56.0 && (eye(130.0) || eye(170.0)) {
                    [20, 20, 30, 255]
                } else if r < 56.0 {
                    [250, 210, 170, 255]
                } else if r < 61.0 {
                    [20, 20, 30, 255]
                } else {
                    [255, 255, 255, 255]
                };
                pixels.extend_from_slice(&px);
            }
        }
        let image = Rgba { width, height, pixels };
        assert_eq!(remover.download(&mut |_| {}), Ok(DownloadOutcome::Done));
        let started = std::time::Instant::now();
        let out = remover.remove(&image).unwrap();
        eprintln!("removal took {:?}", started.elapsed());
        let alpha = |x: u32, y: u32| out.pixels[((y * width + x) * 4 + 3) as usize];
        assert!(alpha(150, 110) > 200, "the face stays: {}", alpha(150, 110));
        for (x, y) in [(5, 5), (294, 5), (5, 194), (294, 194)] {
            assert!(alpha(x, y) < 40, "corner ({x}, {y}) is removed: {}", alpha(x, y));
        }
        assert_eq!(&out.pixels[..3], &image.pixels[..3], "colours are unchanged");
    }

    /// A real cut-out picture (a PNG with a transparent background) laid on
    /// white, removed by the model: prints how well it recovers the picture's
    /// own outline (intersection over union of the opaque pixels) and
    /// requires at least 0.8. Set `SPM_SAMPLE_IMAGE` to the PNG; the model
    /// comes from `SPM_MODEL_DIR`.
    #[test]
    #[ignore = "needs SPM_SAMPLE_IMAGE and the real model"]
    fn the_real_model_recovers_a_sample_cutout() {
        let Some(sample) = std::env::var_os("SPM_SAMPLE_IMAGE") else {
            panic!("set SPM_SAMPLE_IMAGE to a PNG with a transparent background");
        };
        let dir = test_model_dir();
        let cutout = image::open(&sample).expect("readable PNG").to_rgba8();
        let (width, height) = cutout.dimensions();
        let truth: Vec<bool> = cutout.pixels().map(|p| p[3] > 128).collect();
        // On white: what a sticker source picture usually looks like.
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for p in cutout.pixels() {
            let a = u16::from(p[3]);
            for c in 0..3 {
                pixels.push(((u16::from(p[c]) * a + 255 * (255 - a) + 127) / 255) as u8);
            }
            pixels.push(255);
        }
        let image = Rgba { width, height, pixels };
        let remover = BackgroundRemover::new(dir, model::MODEL);
        assert_eq!(remover.download(&mut |_| {}), Ok(DownloadOutcome::Done));
        let out = remover.remove(&image).unwrap();
        let kept = out.pixels.as_chunks::<4>().0.iter().map(|p| p[3] > 128);
        let (mut both, mut either) = (0u64, 0u64);
        for (k, t) in kept.zip(&truth) {
            both += u64::from(k && *t);
            either += u64::from(k || *t);
        }
        let iou = both as f64 / either.max(1) as f64;
        eprintln!("intersection over union {iou:.3}");
        assert!(iou > 0.8, "the outline is recovered: {iou:.3}");
    }
}

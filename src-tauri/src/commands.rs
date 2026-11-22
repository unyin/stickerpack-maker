//! Tauri commands exposed to the webview. The typed TS wrappers live in
//! `src/api.ts`; command names and camelCase field names must stay in sync.

use std::path::PathBuf;
use std::sync::MutexGuard;

use serde::Serialize;
use tauri::{Manager, State};

use crate::config::AppConfig;
use crate::pack_commands::LibraryLock;
use crate::{editor, library, ml, SharedConfig};

/// Library lifecycle status reported to the UI.
/// Mirrors the `LibraryStatus` union in src/api.ts (serde lowercase).
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryStatus {
    Unconfigured,
    Ready,
    Invalid,
}

/// Snapshot of the app configuration for the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateDto {
    pub library_path: Option<String>,
    pub library_status: LibraryStatus,
    /// Why the configured Library is unusable (set only when status = Invalid).
    pub library_error: Option<String>,
}

fn build_state_dto(cfg: &AppConfig) -> AppStateDto {
    match &cfg.library_path {
        None => AppStateDto {
            library_path: None,
            library_status: LibraryStatus::Unconfigured,
            library_error: None,
        },
        Some(dir) => {
            let path = dir.to_string_lossy().into_owned();
            let (status, error) = match library::validate_intact(dir) {
                Ok(()) => (LibraryStatus::Ready, None),
                Err(e) => (LibraryStatus::Invalid, Some(e)),
            };
            AppStateDto {
                library_path: Some(path),
                library_status: status,
                library_error: error,
            }
        }
    }
}

fn lock_config<'a>(
    state: &'a State<'_, SharedConfig>,
) -> Result<MutexGuard<'a, AppConfig>, String> {
    state
        .config
        .lock()
        .map_err(|_| "app config lock poisoned".to_string())
}

/// Persist a new Library path and return the resulting state snapshot.
/// One lock guard is held across clone -> save -> assign so concurrent
/// commands serialize: disk is written before memory is updated, and a
/// failed write never leaves memory and disk disagreeing.
fn set_library_path(
    app: &tauri::AppHandle,
    state: &State<SharedConfig>,
    lock: &State<LibraryLock>,
    dir: PathBuf,
) -> Result<AppStateDto, String> {
    let file = crate::config_file_path(app)?;
    let mut guard = lock_config(state)?;
    let mut next = guard.clone();
    next.library_path = Some(dir);
    next.save(&file)?;
    *guard = next;
    let dto = build_state_dto(&guard);
    // Lock order is serial -> config (`with_library`), so the config guard
    // must be released before `reset()` waits on `serial`. The path is already
    // assigned, so any operation that starts after this point sees the new
    // Library, and `reset()` (under serial) clears what an older one left.
    drop(guard);
    lock.reset(); // the memo is per Library, not per pack id
    Ok(dto)
}

#[tauri::command(async)]
pub fn get_app_state(state: State<'_, SharedConfig>) -> Result<AppStateDto, String> {
    Ok(build_state_dto(&*lock_config(&state)?))
}

/// Suggested default for the first-run flow: Documents\Stickerpack Library.
#[tauri::command]
pub fn default_library_path(app: tauri::AppHandle) -> Result<String, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|e| format!("cannot resolve Documents folder: {e}"))?;
    Ok(documents
        .join("Stickerpack Library")
        .to_string_lossy()
        .into_owned())
}

/// First run / settings: create a fresh Library in a new or empty folder,
/// then persist its path in the app config.
#[tauri::command(async)]
pub fn create_library(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<AppStateDto, String> {
    let dir = PathBuf::from(path);
    library::create_fresh(&dir)?;
    set_library_path(&app, &state, &lock, dir)
}

/// Settings: re-point at another INTACT Library (database included), then
/// persist its path. An older database is upgraded on open; no reconstruction
/// from loose files (SPEC §3).
#[tauri::command(async)]
pub fn repoint_library(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, SharedConfig>,
    lock: State<'_, LibraryLock>,
) -> Result<AppStateDto, String> {
    let dir = PathBuf::from(path);
    library::validate_intact(&dir)?;
    set_library_path(&app, &state, &lock, dir)
}

// ---- Editor (ADR-0005: one-shot pixel work in Rust) ----

/// Header-only probe of an import candidate: displayed size and whether it
/// exceeds the import cap (the UI then asks to scale or cancel).
#[tauri::command(async)]
pub fn editor_probe_image(path: String) -> Result<editor::import::ImageInfo, String> {
    editor::import::probe(&PathBuf::from(path))
}

/// Decode an image for the Editor and return it as a binary frame (u32 LE
/// width, u32 LE height, straight RGBA8) — raw bytes, never JSON.
/// `scale_to_fit` is "Scale to fit" in the import cap dialog.
#[tauri::command(async)]
pub fn editor_import_image(path: String, scale_to_fit: bool) -> Result<tauri::ipc::Response, String> {
    let image = editor::import::import(&PathBuf::from(path), scale_to_fit)?;
    Ok(tauri::ipc::Response::new(image.to_frame()))
}

/// Header carrying the merge request's per-layer sizes and transforms
/// (JSON array of `LayerMeta`); the pixels travel as the raw body.
pub const MERGE_LAYERS_HEADER: &str = "x-merge-layers";

/// Merge selected layers (SPEC §6). Request: raw body = the raster layers'
/// RGBA bytes concatenated bottom to top, header `x-merge-layers` = every
/// layer's size and transform, plus the text of text layers (which have no
/// bytes in the body). Response: `PlacedImage::to_frame` (origin + image).
#[tauri::command(async)]
pub fn editor_merge_layers(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let body = raw_body(&request, "merge")?;
    let meta: Vec<editor::layers::LayerMeta> = serde_json::from_str(header(&request, MERGE_LAYERS_HEADER)?)
        .map_err(|e| format!("merge layer header is invalid: {e}"))?;
    let layers = editor::layers::split_layers(&meta, body, editor::text::system_fonts())?;
    let merged = editor::merge::merge(&layers)?;
    Ok(tauri::ipc::Response::new(merged.to_frame()))
}

/// Header carrying the crop request's per-layer sizes, transforms and clip
/// rectangles (JSON array of `CropMeta`); the pixels travel as the raw body.
pub const CROP_LAYERS_HEADER: &str = "x-crop-layers";

/// Crop layers to the crop box (SPEC §6). Request: raw body = the raster
/// layers' RGBA bytes concatenated, header `x-crop-layers` = their sizes,
/// transforms and clips (text layers carry their text and no bytes).
/// Response: each clip's RGBA bytes, concatenated.
#[tauri::command(async)]
pub fn editor_crop_layers(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let body = raw_body(&request, "crop")?;
    let meta: Vec<editor::crop::CropMeta> = serde_json::from_str(header(&request, CROP_LAYERS_HEADER)?)
        .map_err(|e| format!("crop layer header is invalid: {e}"))?;
    let layers = editor::crop::split_crop_layers(&meta, body, editor::text::system_fonts())?;
    Ok(tauri::ipc::Response::new(editor::crop::crop(&layers)?))
}

/// The raw body of a binary request, or an error naming the request.
fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>, what: &str) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(body) => Ok(body),
        _ => Err(format!("{what} request must carry raw bytes")),
    }
}

/// A request header as text, or an error naming it.
fn header<'a>(request: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| format!("the request is missing the {name} header"))?
        .to_str()
        .map_err(|e| format!("the {name} header is not text: {e}"))
}

/// Header saying whether a pasted image over the import cap may be scaled
/// to fit ("true" is "Scale to fit" in the cap dialog).
pub const SCALE_TO_FIT_HEADER: &str = "x-scale-to-fit";

/// Probe a pasted image (SPM-9): raw body = its encoded bytes (PNG, JPEG or
/// WEBP, as the clipboard gives them). Same answer as `editor_probe_image`.
#[tauri::command(async)]
pub fn editor_probe_pasted(request: tauri::ipc::Request<'_>) -> Result<editor::import::ImageInfo, String> {
    editor::import::probe_bytes(raw_body(&request, "paste")?)
}

/// Decode a pasted image (SPM-9) under the same import cap rule as
/// `editor_import_image`. Request: raw body = the encoded bytes, header
/// `x-scale-to-fit`. Response: `Rgba::to_frame`.
#[tauri::command(async)]
pub fn editor_import_pasted(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let scale_to_fit = header(&request, SCALE_TO_FIT_HEADER)? == "true";
    let image = editor::import::import_bytes(raw_body(&request, "paste")?, scale_to_fit)?;
    Ok(tauri::ipc::Response::new(image.to_frame()))
}

/// The system's font families for the text tool (SPM-9), sorted. The first
/// call scans the font folders, so it runs off the main thread.
#[tauri::command(async)]
pub fn editor_list_fonts() -> Vec<String> {
    editor::text::families(editor::text::system_fonts())
}

/// Draw a text layer at scale 1 (SPM-9): what the view shows and the box the
/// layer is measured by. Response: `TextRender::to_frame` (metrics + image).
#[tauri::command(async)]
pub fn editor_render_text(spec: editor::text::TextSpec) -> Result<tauri::ipc::Response, String> {
    let render = editor::text::render(editor::text::system_fonts(), &spec)?;
    Ok(tauri::ipc::Response::new(render.to_frame()))
}

/// Header carrying the cut request's layer size, transform and selection
/// polygon (JSON `CutMeta`); the layer's pixels travel as the raw body.
pub const CUT_LAYER_HEADER: &str = "x-cut-layer";

/// Cut a selection out of a raster layer (SPM-9). Request: raw body = the
/// layer's RGBA bytes, header `x-cut-layer`. Response: `Cut::to_frame` (the
/// layer with a hole, then the placed cutout).
#[tauri::command(async)]
pub fn editor_cut_layer(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let body = raw_body(&request, "cut")?;
    let meta: editor::cut::CutMeta = serde_json::from_str(header(&request, CUT_LAYER_HEADER)?)
        .map_err(|e| format!("the cut header is invalid: {e}"))?;
    let layer = meta.decode_layer(body)?;
    let cut = editor::cut::cut(&layer, &meta.polygon)?;
    Ok(tauri::ipc::Response::new(cut.to_frame()))
}

// ---- Background removal (SPM-7, ADR-0006) ----

/// Whether the model `model` (an id from ml::model::MODELS) is cached yet,
/// and its download size (its first Remove background asks before downloading).
#[tauri::command]
pub fn editor_background_model_status(
    model: String,
    remover: State<'_, ml::BackgroundRemover>,
) -> Result<ml::ModelStatus, String> {
    Ok(remover.status(ml::model::model_by_id(&model)?))
}

/// Download progress for the Editor's message line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
}

/// Download the model `model` once (a no-op when it is cached), reporting
/// progress on `on_progress`. Resolves "done" or "cancelled"; network and checksum
/// failures are errors with a plain message.
#[tauri::command(async)]
pub fn editor_download_background_model(
    model: String,
    remover: State<'_, ml::BackgroundRemover>,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<ml::DownloadOutcome, String> {
    let spec = ml::model::model_by_id(&model)?;
    let total = spec.size_bytes;
    remover.download(spec, &mut |received| {
        // A closed channel (the view went away) must not stop the download.
        let _ = on_progress.send(DownloadProgress { received, total });
    })
}

/// Stop the model download in progress.
#[tauri::command]
pub fn editor_cancel_background_download(remover: State<'_, ml::BackgroundRemover>) {
    remover.cancel_download();
}

/// Header carrying the removal request's layer size and model (JSON `{width, height, model}`).
pub const REMOVE_BACKGROUND_HEADER: &str = "x-remove-background";

/// Remove the background of a raster layer (SPM-7). Request: raw body = the
/// layer's RGBA bytes, header `x-remove-background`. Response:
/// `Rgba::to_frame`, the same layer with its background's alpha cleared.
#[tauri::command(async)]
pub fn editor_remove_background(
    request: tauri::ipc::Request<'_>,
    remover: State<'_, ml::BackgroundRemover>,
) -> Result<tauri::ipc::Response, String> {
    let meta: ml::RemovalMeta = serde_json::from_str(header(&request, REMOVE_BACKGROUND_HEADER)?)
        .map_err(|e| format!("the background removal header is invalid: {e}"))?;
    let layer = meta.decode(raw_body(&request, "background removal")?)?;
    Ok(tauri::ipc::Response::new(remover.remove(meta.spec()?, &layer)?.to_frame()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_status_serializes_lowercase_for_the_webview() {
        // Must match the LibraryStatus union in src/api.ts exactly.
        assert_eq!(
            serde_json::to_string(&LibraryStatus::Unconfigured).unwrap(),
            "\"unconfigured\""
        );
        assert_eq!(
            serde_json::to_string(&LibraryStatus::Ready).unwrap(),
            "\"ready\""
        );
        assert_eq!(
            serde_json::to_string(&LibraryStatus::Invalid).unwrap(),
            "\"invalid\""
        );
    }

    #[test]
    fn app_state_dto_serializes_camel_case() {
        let dto = AppStateDto {
            library_path: Some("C:\\lib".into()),
            library_status: LibraryStatus::Ready,
            library_error: None,
        };
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["libraryPath"], "C:\\lib");
        assert_eq!(json["libraryStatus"], "ready");
        assert!(json["libraryError"].is_null());
        assert!(json.get("library_path").is_none());
        assert!(json.get("library_status").is_none());
    }
}
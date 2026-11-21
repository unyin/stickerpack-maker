//! Tauri commands exposed to the webview. The typed TS wrappers live in
//! `src/api.ts`; command names and camelCase field names must stay in sync.

use std::path::PathBuf;
use std::sync::MutexGuard;

use serde::Serialize;
use tauri::{Manager, State};

use crate::config::AppConfig;
use crate::pack_commands::LibraryLock;
use crate::{editor, library, SharedConfig};

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
/// `scale_to_fit` is the owner's OK in the import cap dialog.
#[tauri::command(async)]
pub fn editor_import_image(path: String, scale_to_fit: bool) -> Result<tauri::ipc::Response, String> {
    let image = editor::import::import(&PathBuf::from(path), scale_to_fit)?;
    Ok(tauri::ipc::Response::new(image.to_frame()))
}

/// Header carrying the merge request's per-layer sizes and transforms
/// (JSON array of `LayerMeta`); the pixels travel as the raw body.
pub const MERGE_LAYERS_HEADER: &str = "x-merge-layers";

/// Merge selected raster layers (SPEC §6). Request: raw body = the layers'
/// RGBA bytes concatenated bottom to top, header `x-merge-layers` = their
/// sizes and transforms. Response: `PlacedImage::to_frame` (origin + image).
#[tauri::command(async)]
pub fn editor_merge_layers(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("merge request must carry raw pixel bytes".to_string());
    };
    let meta_json = request
        .headers()
        .get(MERGE_LAYERS_HEADER)
        .ok_or_else(|| format!("merge request is missing the {MERGE_LAYERS_HEADER} header"))?
        .to_str()
        .map_err(|e| format!("merge layer header is not text: {e}"))?;
    let meta: Vec<editor::merge::LayerMeta> =
        serde_json::from_str(meta_json).map_err(|e| format!("merge layer header is invalid: {e}"))?;
    let layers = editor::merge::split_layers(&meta, body)?;
    let merged = editor::merge::merge(&layers)?;
    Ok(tauri::ipc::Response::new(merged.to_frame()))
}

/// Header carrying the crop request's per-layer sizes, transforms and clip
/// rectangles (JSON array of `CropMeta`); the pixels travel as the raw body.
pub const CROP_LAYERS_HEADER: &str = "x-crop-layers";

/// Crop raster layers to the crop box (SPEC §6). Request: raw body = the
/// layers' RGBA bytes concatenated, header `x-crop-layers` = their sizes,
/// transforms and clips. Response: each clip's RGBA bytes, concatenated.
#[tauri::command(async)]
pub fn editor_crop_layers(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("crop request must carry raw pixel bytes".to_string());
    };
    let meta_json = request
        .headers()
        .get(CROP_LAYERS_HEADER)
        .ok_or_else(|| format!("crop request is missing the {CROP_LAYERS_HEADER} header"))?
        .to_str()
        .map_err(|e| format!("crop layer header is not text: {e}"))?;
    let meta: Vec<editor::crop::CropMeta> =
        serde_json::from_str(meta_json).map_err(|e| format!("crop layer header is invalid: {e}"))?;
    let layers = editor::crop::split_crop_layers(&meta, body)?;
    Ok(tauri::ipc::Response::new(editor::crop::crop(&layers)?))
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
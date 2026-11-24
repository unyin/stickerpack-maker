//! Tauri commands exposed to the webview. The typed TS wrappers live in
//! `src/api.ts`; command names and camelCase field names must stay in sync.

use std::{fs, path::PathBuf, sync::MutexGuard};

use serde::Serialize;
use tauri::{Manager, State};

use crate::config::{AppConfig, EmojiStyle};
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
    /// The emoji style the app draws with (SPM-17); mirrors the EmojiStyle
    /// union in src/emoji-style.ts (serde lowercase).
    pub emoji_style: EmojiStyle,
    /// The stored custom emoji font path, shown in Settings; only set for
    /// a style chosen at least once, never verified at read time.
    pub custom_emoji_font_path: Option<String>,
}

fn build_state_dto(cfg: &AppConfig) -> AppStateDto {
    let (library_path, library_status, library_error) = match &cfg.library_path {
        None => (None, LibraryStatus::Unconfigured, None),
        Some(dir) => {
            let path = dir.to_string_lossy().into_owned();
            match library::validate_intact(dir) {
                Ok(()) => (Some(path), LibraryStatus::Ready, None),
                Err(e) => (Some(path), LibraryStatus::Invalid, Some(e)),
            }
        }
    };
    AppStateDto {
        library_path,
        library_status,
        library_error,
        emoji_style: cfg.emoji_style,
        custom_emoji_font_path: cfg
            .custom_emoji_font_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
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

// ---- Emoji style (SPM-17) ----

/// Custom emoji font files the Custom style accepts: real font containers
/// the webview's FontFace can parse. Case-insensitive.
const CUSTOM_EMOJI_FONT_EXTENSIONS: [&str; 3] = ["ttf", "otf", "woff2"];

/// A colour-emoji font reaches tens of MB — Noto's CBDT build is ~24 MB
/// and Apple's sbix build ~90 MB+ — and real custom emoji packs can be
/// larger still, so the cap sits at 256 MiB: every known emoji font fits
/// with room, while a deliberately absurd "font" is still refused before
/// its bytes cross into the webview (owner, 2026-11-24: the first cap,
/// 64 MiB, blocked real packs and was raised).
const CUSTOM_EMOJI_FONT_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// Validate a picked custom emoji font path: suffix, existence, size cap.
/// The command takes any path from the webview, so the guard (not the UI's
/// file filter) is the real bound (the editor_import_image precedent).
fn custom_emoji_font_problem(path: &str) -> Option<String> {
    let p = PathBuf::from(path);
    let ext_ok = p
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|e| CUSTOM_EMOJI_FONT_EXTENSIONS.contains(&e.as_str()));
    if !ext_ok {
        return Some(format!("not a .ttf, .otf or .woff2 font file: {path}"));
    }
    match fs::metadata(&p) {
        Ok(m) if m.len() > CUSTOM_EMOJI_FONT_MAX_BYTES => Some(format!(
            "font file {path} is {} MB; the limit is {} MB",
            m.len() / (1024 * 1024),
            CUSTOM_EMOJI_FONT_MAX_BYTES / (1024 * 1024)
        )),
        Ok(_) => None,
        Err(e) => Some(format!("cannot read {path}: {e}")),
    }
}

/// Settings: choose the emoji style (SPM-17) and persist it, then return the
/// resulting state snapshot. `custom_path` goes with style = "custom": the
/// freshly picked font file's path, stored to be read from its original
/// location — never copied into the app or the Library. A non-custom style
/// keeps a stored path, so switching back to Custom needs no re-pick.
#[tauri::command(async)]
pub fn set_emoji_style(
    style: String,
    custom_path: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, SharedConfig>,
) -> Result<AppStateDto, String> {
    // Reject a typo from the UI instead of silently landing on the default.
    let style = EmojiStyle::parse(&style)?;
    let file = crate::config_file_path(&app)?;
    let mut guard = lock_config(&state)?;
    let mut next = guard.clone();
    next.emoji_style = style;
    if let Some(path) = custom_path {
        next.custom_emoji_font_path = Some(PathBuf::from(path));
    }
    // One guard across clone -> save -> assign (the set_library_path pattern):
    // disk is written before memory is updated, so a failed write never
    // leaves the two disagreeing.
    next.save(&file)?;
    *guard = next;
    Ok(build_state_dto(&guard))
}

/// Custom emoji style (SPM-17): the stored font file's bytes, for a FontFace
/// in the webview. Missing or oversized files are refused; a file that exists
/// but is not a real font fails at FontFace.load in the webview, which then
/// falls back to the Android style with a message.
#[tauri::command(async)]
pub fn read_custom_emoji_font(path: String) -> Result<tauri::ipc::Response, String> {
    if let Some(problem) = custom_emoji_font_problem(&path) {
        return Err(problem);
    }
    let bytes = fs::read(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ---- The text renderer's emoji chain (SPM-20) ----

/// The bundled emoji fonts' asset paths (SPM-17's files in public/fonts,
/// which vite copies into dist/, the app's frontendDist).
const BUNDLED_NOTO: &str = "fonts/Noto-COLRv1.ttf";
const BUNDLED_TWEMOJI: &str = "fonts/Twemoji_COLRv1.ttf";

/// A bundled emoji font's bytes, cached for the process: the embedded
/// frontendDist asset at release (AssetResolver — no installer growth; the
/// bytes already ship in the exe), dist/ from disk in dev, and in a dev
/// run without a built dist the very file the dev webview serves from
/// public/ (a stale-or-absent dist must not desync the canvas from the
/// DOM). The public/ fallback compiles out of release, where the resolver
/// always works.
fn bundled_emoji_font(app: &tauri::AppHandle, path: &str) -> Option<std::sync::Arc<Vec<u8>>> {
    if let Some(asset) = app.asset_resolver().get(path.to_string()) {
        return Some(std::sync::Arc::new(asset.bytes));
    }
    #[cfg(debug_assertions)]
    {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public").join(path);
        if let Ok(bytes) = fs::read(&file) {
            return Some(std::sync::Arc::new(bytes));
        }
    }
    eprintln!("cannot load the bundled emoji font {path}; emoji fall back to the system fonts");
    None
}

fn noto_bytes(app: &tauri::AppHandle) -> Option<std::sync::Arc<Vec<u8>>> {
    static CACHE: std::sync::OnceLock<Option<std::sync::Arc<Vec<u8>>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| bundled_emoji_font(app, BUNDLED_NOTO)).clone()
}

fn twemoji_bytes(app: &tauri::AppHandle) -> Option<std::sync::Arc<Vec<u8>>> {
    static CACHE: std::sync::OnceLock<Option<std::sync::Arc<Vec<u8>>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| bundled_emoji_font(app, BUNDLED_TWEMOJI)).clone()
}

/// The custom style's font file read from its stored path, cached by path
/// (the canvas twin of the webview's one FontFace under the alias): the
/// read_custom_emoji_font guards apply, and a file the Rust parser cannot
/// read (woff2, say — a documented limit) is skipped, falling to the
/// bundled Noto behind it.
type CustomEmojiFontCache = std::sync::Mutex<Option<(PathBuf, std::sync::Arc<Vec<u8>>)>>;

fn custom_emoji_font_bytes(path: &PathBuf) -> Option<std::sync::Arc<Vec<u8>>> {
    static CACHE: std::sync::OnceLock<CustomEmojiFontCache> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((cached, bytes)) = guard.as_ref() {
            if cached == path {
                return Some(bytes.clone());
            }
        }
    }
    let bytes = match custom_emoji_font_problem(&path.to_string_lossy()) {
        Some(why) => {
            eprintln!("the custom emoji font is skipped: {why}");
            None
        }
        None => match fs::read(path) {
            Ok(bytes) => Some(std::sync::Arc::new(bytes)),
            Err(e) => {
                eprintln!("the custom emoji font is skipped: cannot read {}: {e}", path.display());
                None
            }
        },
    };
    if let (Ok(mut guard), Some(bytes)) = (cache.lock(), &bytes) {
        *guard = Some((path.clone(), bytes.clone()));
    }
    bytes
}

/// The emoji font chain for the current style (SPM-20), the Rust twin of
/// the webview's EMOJI_STYLE_STACKS (src/emoji-style.ts): the style's own
/// font first, then the system emoji fonts. A chain font that covers a
/// character only in monochrome is skipped by the renderer itself
/// (never monochrome outlines, SPEC §5), so the tail never draws emoji
/// where the style's font already could.
fn emoji_fonts(app: &tauri::AppHandle, cfg: &AppConfig) -> editor::emoji::EmojiFonts {
    use editor::emoji::{EmojiSource, EmojiFonts};
    let mut sources: Vec<EmojiSource> = Vec::new();
    match cfg.emoji_style {
        EmojiStyle::Android => {
            if let Some(bytes) = noto_bytes(app) {
                sources.push(EmojiSource::Bytes(bytes));
            }
        }
        EmojiStyle::Twemoji => {
            if let Some(bytes) = twemoji_bytes(app) {
                sources.push(EmojiSource::Bytes(bytes));
            }
        }
        // Nothing bundled: the system Segoe IS the style's font.
        EmojiStyle::Windows => {}
        EmojiStyle::Custom => {
            if let Some(path) = &cfg.custom_emoji_font_path {
                if let Some(bytes) = custom_emoji_font_bytes(path) {
                    sources.push(EmojiSource::Bytes(bytes));
                }
            }
            // A broken, missing or unparsable custom file falls to the
            // bundled Noto, the canvas twin of the webview's Android
            // fallback (SPM-17's applyEmojiStyle).
            if let Some(bytes) = noto_bytes(app) {
                sources.push(EmojiSource::Bytes(bytes));
            }
        }
    }
    for family in ["Segoe UI Emoji", "Noto Color Emoji"] {
        let query =
            fontdb::Query { families: &[fontdb::Family::Name(family)], ..fontdb::Query::default() };
        if let Some(id) = editor::text::system_fonts().query(&query) {
            sources.push(EmojiSource::System(id));
        }
    }
    EmojiFonts::new(sources)
}

/// The style's emoji chain as the commands take it (SPM-20): the config is
/// read under its lock and the guard is DROPPED here, before any pixel
/// work — `with_library` re-locks the config (pack_commands.rs documents
/// the order), so a caller holding it across a save deadlocks the app.
pub(crate) fn style_emoji_fonts(
    app: &tauri::AppHandle,
    state: &State<'_, SharedConfig>,
) -> Result<editor::emoji::EmojiFonts, String> {
    let config = lock_config(state)?;
    Ok(emoji_fonts(app, &config))
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
/// bytes in the body). A text layer rasterises with the style's emoji
/// chain (SPM-20). Response: `PlacedImage::to_frame` (origin + image).
#[tauri::command(async)]
pub fn editor_merge_layers(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
    state: State<'_, SharedConfig>,
) -> Result<tauri::ipc::Response, String> {
    let body = raw_body(&request, "merge")?;
    let meta: Vec<editor::layers::LayerMeta> = serde_json::from_str(header(&request, MERGE_LAYERS_HEADER)?)
        .map_err(|e| format!("merge layer header is invalid: {e}"))?;
    let emoji = style_emoji_fonts(&app, &state)?;
    let layers = editor::layers::split_layers(&meta, body, editor::text::system_fonts(), &emoji)?;
    let merged = editor::merge::merge(&layers)?;
    Ok(tauri::ipc::Response::new(merged.to_frame()))
}

/// Header carrying the crop request's per-layer sizes, transforms and clip
/// rectangles (JSON array of `CropMeta`); the pixels travel as the raw body.
pub const CROP_LAYERS_HEADER: &str = "x-crop-layers";

/// Crop layers to the crop box (SPEC §6). Request: raw body = the raster
/// layers' RGBA bytes concatenated, header `x-crop-layers` = their sizes,
/// transforms and clips (text layers carry their text and no bytes). A
/// text layer rasterises with the style's emoji chain (SPM-20).
/// Response: each clip's RGBA bytes, concatenated.
#[tauri::command(async)]
pub fn editor_crop_layers(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
    state: State<'_, SharedConfig>,
) -> Result<tauri::ipc::Response, String> {
    let body = raw_body(&request, "crop")?;
    let meta: Vec<editor::crop::CropMeta> = serde_json::from_str(header(&request, CROP_LAYERS_HEADER)?)
        .map_err(|e| format!("crop layer header is invalid: {e}"))?;
    let emoji = style_emoji_fonts(&app, &state)?;
    let layers = editor::crop::split_crop_layers(&meta, body, editor::text::system_fonts(), &emoji)?;
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
/// layer is measured by. Emoji draw from the style's chain, in colour
/// (SPM-20). Response: `TextRender::to_frame` (metrics + image).
#[tauri::command(async)]
pub fn editor_render_text(
    spec: editor::text::TextSpec,
    app: tauri::AppHandle,
    state: State<'_, SharedConfig>,
) -> Result<tauri::ipc::Response, String> {
    let emoji = style_emoji_fonts(&app, &state)?;
    let render = editor::text::render(editor::text::system_fonts(), &emoji, &spec)?;
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

/// Header carrying the effect request's layer size, transform (or text)
/// and effect settings (JSON `EffectMeta`); a raster layer's pixels travel
/// as the raw body.
pub const EFFECT_HEADER: &str = "x-effect";

/// Draw an outline or fuzzy glow on one layer (SPM-8): both the live
/// preview and the result Apply bakes in (ADR-0008). Request: raw body =
/// the raster layer's RGBA bytes (none for a text layer, which Rust
/// rasterises with the style's emoji chain, SPM-20), header `x-effect`.
/// Response: `EffectResult::to_frame` (the new transform, then the
/// grown image).
#[tauri::command(async)]
pub fn editor_apply_effect(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
    state: State<'_, SharedConfig>,
) -> Result<tauri::ipc::Response, String> {
    let body = raw_body(&request, "effect")?;
    let meta: editor::effects::EffectMeta = serde_json::from_str(header(&request, EFFECT_HEADER)?)
        .map_err(|e| format!("the effect header is invalid: {e}"))?;
    let emoji = style_emoji_fonts(&app, &state)?;
    let layer = meta.decode_layer(body, editor::text::system_fonts(), &emoji)?;
    let result = editor::effects::apply(&layer, &meta.effect)?;
    Ok(tauri::ipc::Response::new(result.to_frame()))
}

// ---- Background removal (SPM-7, ADR-0006) ----

/// Whether the model is cached yet, and its download size (the first
/// Remove background asks before downloading).
#[tauri::command]
pub fn editor_background_model_status(remover: State<'_, ml::BackgroundRemover>) -> ml::ModelStatus {
    remover.status()
}

/// Download progress for the Editor's message line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
}

/// Download the model once (a no-op when it is cached), reporting progress
/// on `on_progress`. Resolves "done" or "cancelled"; network and checksum
/// failures are errors with a plain message.
#[tauri::command(async)]
pub fn editor_download_background_model(
    remover: State<'_, ml::BackgroundRemover>,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<ml::DownloadOutcome, String> {
    let total = remover.size_bytes();
    remover.download(&mut |received| {
        // A closed channel (the view went away) must not stop the download.
        let _ = on_progress.send(DownloadProgress { received, total });
    })
}

/// Stop the model download in progress.
#[tauri::command]
pub fn editor_cancel_background_download(remover: State<'_, ml::BackgroundRemover>) {
    remover.cancel_download();
}

/// Header carrying the removal request's layer size (JSON `{width, height}`).
pub const REMOVE_BACKGROUND_HEADER: &str = "x-remove-background";

/// Remove the background of a raster layer (SPM-7). Request: raw body = the
/// layer's RGBA bytes, header `x-remove-background`. Response:
/// `Rgba::to_frame`, the same layer with its background's alpha cleared.
#[tauri::command(async)]
pub fn editor_remove_background(
    request: tauri::ipc::Request<'_>,
    remover: State<'_, ml::BackgroundRemover>,
) -> Result<tauri::ipc::Response, String> {
    let size: ml::LayerSize = serde_json::from_str(header(&request, REMOVE_BACKGROUND_HEADER)?)
        .map_err(|e| format!("the background removal header is invalid: {e}"))?;
    let layer = size.decode(raw_body(&request, "background removal")?)?;
    Ok(tauri::ipc::Response::new(remover.remove(&layer)?.to_frame()))
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
            emoji_style: EmojiStyle::Custom,
            custom_emoji_font_path: Some("C:\\Fonts\\my-emoji.ttf".into()),
        };
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["libraryPath"], "C:\\lib");
        assert_eq!(json["libraryStatus"], "ready");
        assert!(json["libraryError"].is_null());
        assert!(json.get("library_path").is_none());
        assert!(json.get("library_status").is_none());
        // The emoji fields mirror the EmojiStyle union in src/emoji-style.ts.
        assert_eq!(json["emojiStyle"], "custom");
        assert_eq!(json["customEmojiFontPath"], "C:\\Fonts\\my-emoji.ttf");
    }

    #[test]
    fn emoji_style_serializes_lowercase_for_the_webview() {
        for (value, text) in [
            (EmojiStyle::Android, "android"),
            (EmojiStyle::Twemoji, "twemoji"),
            (EmojiStyle::Windows, "windows"),
            (EmojiStyle::Custom, "custom"),
        ] {
            // Serialization must match the EmojiStyle union in
            // src/emoji-style.ts exactly; parse takes the SAME bare value
            // the IPC command receives (the Windows-test bug, owner
            // 2026-11-24: a quoted string is not the bare value).
            assert_eq!(serde_json::to_string(&value).unwrap(), format!("\"{text}\""));
            assert_eq!(EmojiStyle::parse(text).unwrap(), value);
        }
        assert!(EmojiStyle::parse("apple").is_err());
    }

    #[test]
    fn custom_emoji_font_guard_checks_suffix_existence_and_cap() {
        let dir = tempfile::tempdir().unwrap();
        let ttf = dir.path().join("my.ttf");
        fs::write(&ttf, b"x").unwrap();
        // A real file with a font suffix passes; extension matching is
        // case-insensitive the way Windows paths are.
        assert_eq!(custom_emoji_font_problem(ttf.to_str().unwrap()), None);
        let uppercase = dir.path().join("MY.TTF");
        fs::write(&uppercase, b"x").unwrap();
        assert_eq!(custom_emoji_font_problem(uppercase.to_str().unwrap()), None);
        // Wrong container: refused even though the file exists.
        let exe = dir.path().join("font.exe");
        fs::write(&exe, b"x").unwrap();
        assert!(custom_emoji_font_problem(exe.to_str().unwrap()).is_some());
        // Missing file: the suffix is right, the read would not be.
        let missing = dir.path().join("gone.woff2");
        let problem = custom_emoji_font_problem(missing.to_str().unwrap());
        assert!(problem.unwrap().starts_with("cannot read"));
        // No extension at all.
        assert!(custom_emoji_font_problem("C:\\Fonts\\font").is_some());
    }
}
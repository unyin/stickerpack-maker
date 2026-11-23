mod commands;
mod config;
mod db;
/// Pack Manager commands (SPM-3) over the Library core.
mod pack_commands;
/// The Editor's save command (SPM-10): editor pixel work + the Library core.
mod save_commands;
/// Editor pixel work (ADR-0005): Tauri-free, unit-tested; commands wrap it.
pub mod editor;
/// Library core (SPEC §3-4): data model, file operations, crash-safe
/// renames, desync detection. Public because the core is a UI-agnostic,
/// unit-testable library; Tauri command wiring (SPM-3) consumes it.
pub mod library;
/// Sticker, thumbnail and import limits: one definition shared with the
/// webview (src/shared/limits.json, read by build.rs).
pub mod limits;
/// Background removal (SPM-7, ADR-0006): ONNX segmentation model, its
/// one-time verified download and cache; Tauri-free like the editor code.
pub mod ml;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// Shared app state: the persisted configuration, guarded by a mutex because
/// Tauri commands may run on different threads. (Named SharedConfig, not
/// AppState, to avoid colliding with the UI-facing AppStateDto / TS AppState.)
pub struct SharedConfig {
    pub config: Mutex<config::AppConfig>,
}

/// Location of the persisted app config file. It lives in the OS app-config
/// directory, NOT inside the Library: the Library is portable (re-pointable),
/// the config is machine-local.
pub fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config directory: {e}"))?;
    Ok(dir.join("config.json"))
}

/// The background removal model cache (ADR-0006): machine-local, in the OS
/// app-data directory like the config, never in the portable Library.
pub fn model_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data directory: {e}"))?;
    Ok(dir.join("models"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pack_commands::LibraryLock::default())
        .setup(|app| {
            let path = config_file_path(app.handle())?;
            let cfg = config::AppConfig::load(&path)?;
            app.manage(SharedConfig {
                config: Mutex::new(cfg),
            });
            app.manage(ml::BackgroundRemover::new(model_cache_dir(app.handle())?, ml::model::MODEL));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::default_library_path,
            commands::create_library,
            commands::repoint_library,
            commands::editor_probe_image,
            commands::editor_import_image,
            commands::editor_merge_layers,
            commands::editor_crop_layers,
            commands::editor_probe_pasted,
            commands::editor_import_pasted,
            commands::editor_list_fonts,
            commands::editor_render_text,
            commands::editor_cut_layer,
            commands::editor_background_model_status,
            commands::editor_download_background_model,
            commands::editor_cancel_background_download,
            commands::editor_remove_background,
            save_commands::editor_save_image,
            pack_commands::list_packs,
            pack_commands::suggest_short_name,
            pack_commands::create_pack,
            pack_commands::delete_pack,
            pack_commands::open_pack,
            pack_commands::load_pack_view,
            pack_commands::set_pack_title,
            pack_commands::set_pack_short_name,
            pack_commands::set_pack_status,
            pack_commands::reorder_sticker,
            pack_commands::delete_stickers,
            pack_commands::set_emoji_string,
            pack_commands::import_stickers,
            pack_commands::check_sticker_file,
            pack_commands::replace_sticker,
            pack_commands::send_to_pack,
            pack_commands::sticker_file_path,
            pack_commands::reveal_sticker,
            pack_commands::reveal_pack,
            pack_commands::reveal_thumbnail,
            pack_commands::sticker_image,
            pack_commands::thumbnail_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
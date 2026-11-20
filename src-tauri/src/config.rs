//! Persisted app configuration.
//!
//! Holds the configured Library path (and nothing else yet). This module is
//! deliberately free of Tauri types so it can be unit-tested with plain paths.
//! The config file location is resolved in `lib.rs::config_file_path`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// Absolute path of the Library folder, once configured.
    pub library_path: Option<PathBuf>,
}

impl AppConfig {
    /// Load config from `path`. A missing file means first run (default config).
    /// A corrupt file is an error: silently resetting it would orphan the
    /// configured Library.
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(format!("cannot read config {}: {e}", path.display())),
        };
        serde_json::from_str(&text)
            .map_err(|e| format!("config {} is corrupt: {e}", path.display()))
    }

    /// Write config as pretty JSON, creating parent folders as needed.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!("cannot create config directory {}: {e}", parent.display())
            })?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| format!("cannot serialize config: {e}"))?;
        fs::write(path, text).map_err(|e| format!("cannot write config {}: {e}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_means_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = AppConfig::load(&dir.path().join("config.json")).unwrap();
        assert_eq!(cfg, AppConfig::default());
        assert!(cfg.library_path.is_none());
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.json");
        let cfg = AppConfig {
            library_path: Some(PathBuf::from(r"C:\Users\test\Documents\Stickerpack Library")),
        };
        cfg.save(&path).unwrap();
        assert_eq!(AppConfig::load(&path).unwrap(), cfg);
    }

    #[test]
    fn corrupt_config_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(AppConfig::load(&path).is_err());
    }

    #[test]
    fn serializes_camel_case_for_the_webview() {
        let cfg = AppConfig {
            library_path: Some(PathBuf::from(r"C:\lib")),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("libraryPath"));
    }
}
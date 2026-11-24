//! Persisted app configuration.
//!
//! Holds the configured Library path and the emoji style choice (SPM-17).
//! This module is deliberately free of Tauri types so it can be unit-tested
//! with plain paths. The config file location is resolved in
//! `lib.rs::config_file_path`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmojiStyle {
    /// Bundled Noto Color Emoji (default; owner decision 2026-11-21).
    #[default]
    Android,
    /// Bundled Twemoji.
    Twemoji,
    /// System Segoe UI Emoji; nothing bundled.
    Windows,
    /// A local font file the user picked; the path is stored, never shipped.
    Custom,
}

impl EmojiStyle {
    /// Parse the raw IPC style value (the command's `style: String`
    /// argument, bare — not a JSON document). Unknown values are an error,
    /// not a silent default: a typo in the UI must not land the app on
    /// Android. The config uses the typed field, so its load path is
    /// strict the same way (this module's corrupt-file doctrine).
    /// Mirrors the value set of parseEmojiStyle in src/emoji-style.ts.
    pub fn parse(value: &str) -> Result<Self, String> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
            .map_err(|_| format!("unknown emoji style: {value}"))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// Absolute path of the Library folder, once configured.
    #[serde(default)]
    pub library_path: Option<PathBuf>,
    /// Which emoji style the app draws with (SPM-17); the default when absent.
    /// A new field a later version could not have written defaults cleanly.
    #[serde(default)]
    pub emoji_style: EmojiStyle,
    /// Absolute path of the user's custom emoji font, as picked. Only read
    /// from its original location; never copied into the app or the Library.
    #[serde(default)]
    pub custom_emoji_font_path: Option<PathBuf>,
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
    fn save_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.json");
        let cfg = AppConfig {
            library_path: Some(PathBuf::from(r"C:\Users\test\Documents\Stickerpack Library")),
            emoji_style: EmojiStyle::Custom,
            custom_emoji_font_path: Some(PathBuf::from(r"C:\Fonts\my-emoji.ttf")),
        };
        cfg.save(&path).unwrap();
        assert_eq!(AppConfig::load(&path).unwrap(), cfg);
    }

    #[test]
    fn missing_file_means_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = AppConfig::load(&dir.path().join("config.json")).unwrap();
        assert_eq!(cfg, AppConfig::default());
        assert!(cfg.library_path.is_none());
        // Default style: the bundled Android (Noto) choice, no custom path.
        assert_eq!(cfg.emoji_style, EmojiStyle::Android);
        assert!(cfg.custom_emoji_font_path.is_none());
    }

    #[test]
    fn emoji_style_field_defaults_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        // An older config version without the SPM-17 fields loads untouched,
        // exactly like the enum's default: nothing is rewritten silently.
        fs::write(&path, r#"{"libraryPath": "C:\\lib"}"#).unwrap();
        let cfg = AppConfig::load(&path).unwrap();
        assert_eq!(cfg.library_path, Some(PathBuf::from(r"C:\lib")));
        assert_eq!(cfg.emoji_style, EmojiStyle::Android);
        assert!(cfg.custom_emoji_font_path.is_none());
    }

    #[test]
    fn unknown_emoji_style_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, r#"{"emojiStyle": "apple"}"#).unwrap();
        // The typed field keeps the file's doctrine: never silently reset.
        assert!(AppConfig::load(&path).is_err());
    }

    #[test]
    fn emoji_style_parse_accepted_and_rejected() {
        // Bare values: the IPC argument is a plain string, never a JSON
        // document (the Windows-test bug, owner 2026-11-24: quoting them
        // inside parse made every real choice "unknown").
        assert_eq!(EmojiStyle::parse("android").unwrap(), EmojiStyle::Android);
        assert_eq!(EmojiStyle::parse("twemoji").unwrap(), EmojiStyle::Twemoji);
        assert_eq!(EmojiStyle::parse("windows").unwrap(), EmojiStyle::Windows);
        assert_eq!(EmojiStyle::parse("custom").unwrap(), EmojiStyle::Custom);
        assert!(EmojiStyle::parse("apple").is_err());
        assert!(EmojiStyle::parse("\"twemoji\"").is_err()); // a quoted string is not the bare value
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
            emoji_style: EmojiStyle::Twemoji,
            custom_emoji_font_path: None,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("libraryPath"));
        assert!(json.contains("emojiStyle"));
        assert!(!json.contains("library_path"));
    }
}
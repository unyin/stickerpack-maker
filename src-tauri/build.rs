use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    limits();
    tauri_build::build()
}

/// Every sticker, thumbnail and import limit (SPEC §6-7) has ONE definition,
/// shared with the webview: src/shared/limits.json. The webview imports that
/// file; this generates the Rust constants from it for src/limits.rs.
fn limits() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let path = manifest.join("../src/shared/limits.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let json: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));
    let get = |pointer: &str| positive(&path, &json, pointer);
    // Free resize and the sizing tools accept sides up to the import cap, so
    // a sticker or thumbnail side above it could never be reached.
    for side in ["/sticker/side", "/thumbnail/side"] {
        assert!(
            get("/importMaxSide") >= get(side),
            "{}: importMaxSide must be at least {side}",
            path.display()
        );
    }
    let code = format!(
        "/// Largest side an imported image may have without scaling (SPEC §6).\n\
         pub const IMPORT_MAX_SIDE: u32 = {};\n\
         /// Sticker mode: the longest side must be exactly this (SPEC §7).\n\
         pub const STICKER_SIDE: u32 = {};\n\
         /// Sticker mode: largest file, in KB of 1024 bytes (SPEC §7).\n\
         pub const STICKER_MAX_KB: u64 = {};\n\
         /// Thumbnail mode: exactly this many pixels square (SPEC §7).\n\
         pub const THUMBNAIL_SIDE: u32 = {};\n\
         /// Thumbnail mode: largest file, in KB of 1024 bytes (SPEC §7).\n\
         pub const THUMBNAIL_MAX_KB: u64 = {};\n",
        get("/importMaxSide"),
        get("/sticker/side"),
        get("/sticker/maxKilobytes"),
        get("/thumbnail/side"),
        get("/thumbnail/maxKilobytes"),
    );
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("limits.rs");
    fs::write(&out, code).unwrap_or_else(|e| panic!("cannot write {}: {e}", out.display()));
}

/// The whole number at `pointer` (1 to u32::MAX), or a build failure naming it.
fn positive(path: &Path, json: &serde_json::Value, pointer: &str) -> u64 {
    json.pointer(pointer)
        .and_then(serde_json::Value::as_u64)
        .filter(|&n| n >= 1 && n <= u64::from(u32::MAX))
        .unwrap_or_else(|| panic!("{}: {pointer} must be a whole number, 1 or more", path.display()))
}

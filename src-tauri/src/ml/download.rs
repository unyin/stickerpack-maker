//! The model cache and its one-time download (ADR-0006): the file lives in
//! `<app data>/models/`, arrives as `<file>.part`, and is renamed into
//! place only when its size and SHA-256 match the pinned ones.

use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::model::ModelSpec;

/// How a download ended when it did not fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadOutcome {
    Done,
    Cancelled,
}

/// Progress reports are sent at most once per this many bytes (and at the end).
const PROGRESS_STEP: u64 = 1 << 20;
const CHUNK: usize = 1 << 16;

/// Where a model lives in the cache folder.
pub fn model_path(cache_dir: &Path, spec: &ModelSpec) -> PathBuf {
    cache_dir.join(spec.file_name)
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

/// True when the model file is in the cache at its exact size (its hash is
/// checked when it is loaded, `verify_file`).
pub fn is_cached(cache_dir: &Path, spec: &ModelSpec) -> bool {
    fs::metadata(model_path(cache_dir, spec)).is_ok_and(|m| m.is_file() && m.len() == spec.size_bytes)
}

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 of a file, lowercase hex.
pub fn file_sha256(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut reader = BufReader::with_capacity(CHUNK, file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// What the Editor says when the cached model is damaged.
pub const DAMAGED_MODEL: &str =
    "The downloaded background removal model was damaged, so it was deleted. Click Remove background again to download it afresh.";

/// Check a cached model against its pinned hash; a mismatch deletes it.
pub fn verify_file(path: &Path, spec: &ModelSpec) -> Result<(), String> {
    if file_sha256(path)? == spec.sha256 {
        return Ok(());
    }
    let _ = fs::remove_file(path);
    Err(DAMAGED_MODEL.into())
}

/// Copy `body` into `dest`, checking it against `spec` (exact size and
/// SHA-256) before it takes the final name. `progress` gets the bytes
/// received so far; `cancel` stops the copy between chunks. On any failure
/// or cancel the part file is deleted and `dest` is left as it was.
pub fn save_verified(
    body: &mut dyn Read,
    dest: &Path,
    spec: &ModelSpec,
    progress: &mut dyn FnMut(u64),
    cancel: &AtomicBool,
) -> Result<DownloadOutcome, String> {
    let part = part_path(dest);
    let result = copy_checked(body, &part, spec, progress, cancel);
    match result {
        Ok(DownloadOutcome::Done) => fs::rename(&part, dest).map(|()| DownloadOutcome::Done).map_err(|e| {
            let _ = fs::remove_file(&part);
            format!("cannot save the background removal model: {e}")
        }),
        other => {
            let _ = fs::remove_file(&part);
            other
        }
    }
}

fn copy_checked(
    body: &mut dyn Read,
    part: &Path,
    spec: &ModelSpec,
    progress: &mut dyn FnMut(u64),
    cancel: &AtomicBool,
) -> Result<DownloadOutcome, String> {
    if let Some(dir) = part.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("cannot create the model folder {}: {e}", dir.display()))?;
    }
    let mut file = File::create(part).map_err(|e| format!("cannot save the background removal model: {e}"))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut reported: u64 = 0;
    let mut buf = vec![0u8; CHUNK];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(DownloadOutcome::Cancelled);
        }
        let n = body.read(&mut buf).map_err(|e| interrupted(&e))?;
        if n == 0 {
            break;
        }
        received += n as u64;
        if received > spec.size_bytes {
            return Err(damaged_download());
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| format!("cannot save the background removal model: {e}"))?;
        if received - reported >= PROGRESS_STEP {
            reported = received;
            progress(received);
        }
    }
    file.sync_all().map_err(|e| format!("cannot save the background removal model: {e}"))?;
    progress(received);
    if received != spec.size_bytes || hex(&hasher.finalize()) != spec.sha256 {
        return Err(damaged_download());
    }
    Ok(DownloadOutcome::Done)
}

fn damaged_download() -> String {
    "The downloaded model did not match its checksum, so it was discarded. Try again; if it keeps failing, the download source may have changed.".into()
}

fn interrupted(e: &dyn std::fmt::Display) -> String {
    format!("The model download was interrupted ({e}). Check your internet connection and try again.")
}

/// Download `spec` into `cache_dir` over HTTPS (redirects followed).
/// Network failures become one plain message: the Editor shows it in the
/// message line and the next click tries again.
pub fn download(
    cache_dir: &Path,
    spec: &ModelSpec,
    progress: &mut dyn FnMut(u64),
    cancel: &AtomicBool,
) -> Result<DownloadOutcome, String> {
    let agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(20)))
        // A stalled connection fails instead of hanging the download forever.
        .timeout_per_read(Some(Duration::from_secs(60)))
        .build()
        .new_agent();
    let response = agent.get(spec.url).call().map_err(|e| match e {
        ureq::Error::StatusCode(code) => {
            format!("The model download server answered with error {code}. Try again later.")
        }
        other => format!(
            "Could not reach the model download server ({other}). Check your internet connection and try again."
        ),
    })?;
    // One byte over the expected size is enough to know the file is wrong.
    let mut body = response.into_body().into_with_config().limit(spec.size_bytes + 1).reader();
    save_verified(&mut body, &model_path(cache_dir, spec), spec, progress, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// A spec pinned to `bytes`, as the real one is pinned to the model.
    fn spec_for(bytes: &[u8]) -> ModelSpec {
        let sha: &'static str = Box::leak(hex(&Sha256::digest(bytes)).into_boxed_str());
        ModelSpec { file_name: "model.onnx", sha256: sha, size_bytes: bytes.len() as u64, ..super::super::model::MODEL }
    }

    fn content(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 7 % 251) as u8).collect()
    }

    #[test]
    fn a_matching_download_is_saved_under_its_final_name() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = content(3 * CHUNK + 5);
        let spec = spec_for(&bytes);
        let dest = model_path(dir.path(), &spec);
        let mut seen = Vec::new();
        let outcome =
            save_verified(&mut Cursor::new(bytes.clone()), &dest, &spec, &mut |n| seen.push(n), &AtomicBool::new(false));
        assert_eq!(outcome, Ok(DownloadOutcome::Done));
        assert_eq!(fs::read(&dest).unwrap(), bytes);
        assert!(!part_path(&dest).exists());
        assert_eq!(seen.last(), Some(&(bytes.len() as u64)));
        assert!(is_cached(dir.path(), &spec));
        assert_eq!(verify_file(&dest, &spec), Ok(()));
    }

    #[test]
    fn a_download_with_the_wrong_hash_is_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let spec = spec_for(&content(1000));
        let mut wrong = content(1000);
        wrong[500] ^= 1;
        let dest = model_path(dir.path(), &spec);
        let outcome = save_verified(&mut Cursor::new(wrong), &dest, &spec, &mut |_| {}, &AtomicBool::new(false));
        assert!(outcome.unwrap_err().contains("checksum"));
        assert!(!dest.exists() && !part_path(&dest).exists());
        assert!(!is_cached(dir.path(), &spec));
    }

    #[test]
    fn a_short_or_long_download_is_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = content(1000);
        let spec = spec_for(&bytes);
        let dest = model_path(dir.path(), &spec);
        for body in [bytes[..999].to_vec(), [bytes.clone(), vec![0]].concat()] {
            let outcome = save_verified(&mut Cursor::new(body), &dest, &spec, &mut |_| {}, &AtomicBool::new(false));
            assert!(outcome.is_err());
            assert!(!dest.exists() && !part_path(&dest).exists());
        }
    }

    #[test]
    fn a_cancelled_download_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = content(1000);
        let spec = spec_for(&bytes);
        let dest = model_path(dir.path(), &spec);
        let outcome = save_verified(&mut Cursor::new(bytes), &dest, &spec, &mut |_| {}, &AtomicBool::new(true));
        assert_eq!(outcome, Ok(DownloadOutcome::Cancelled));
        assert!(!dest.exists() && !part_path(&dest).exists());
    }

    #[test]
    fn a_damaged_cached_model_is_deleted_when_verified() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = content(64);
        let spec = spec_for(&bytes);
        let dest = model_path(dir.path(), &spec);
        let mut damaged = bytes.clone();
        damaged[0] ^= 0xff;
        fs::write(&dest, &damaged).unwrap();
        assert!(is_cached(dir.path(), &spec), "same size, so it looks cached until verified");
        assert_eq!(verify_file(&dest, &spec), Err(DAMAGED_MODEL.to_string()));
        assert!(!dest.exists());
    }

    #[test]
    fn a_file_of_the_wrong_size_is_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let spec = spec_for(&content(64));
        fs::write(model_path(dir.path(), &spec), content(63)).unwrap();
        assert!(!is_cached(dir.path(), &spec));
    }
}

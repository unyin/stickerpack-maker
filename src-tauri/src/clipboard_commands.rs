//! The image clipboard (SPM-67, SPEC §2): two commands over `arboard` — one
//! writes an RGBA image to the system clipboard, one reads a clipboard image
//! back for the Paste button. The pure frame work is `crate::clipboard`.
//!
//! Pixels cross the Tauri boundary as raw bytes, never JSON (ADR-0005): the
//! set request's body is the frame every pixel command shares (u32 LE width,
//! u32 LE height, then straight RGBA8), and the get response is the same
//! frame. Neither carries a header: the frame names its own size.
//!
//! On Windows `set_image` already writes both formats the task asks for — the
//! registered "PNG" format and an alpha-carrying `CF_DIBV5` (`arboard`'s
//! src/platform/windows.rs: `SetClipboardData(CF_DIBV5, …)` then
//! `register_format("PNG")` with the PNG bytes), which is what
//! Chromium/WebView2, Qt apps (Telegram Desktop), GIMP and Office read, so the
//! DIB encoder is arboard's rather than ours. `get_image` reads the PNG format
//! first and falls back to `CF_DIBV5`.
//!
//! The webview's own paste event stays for Ctrl+V (SPEC §2): it also takes
//! image files copied in Explorer, which the clipboard's image formats never
//! carry.
//!
//! No UI caller yet: SPM-68 wires the Editor's Copy/Paste and the Pack
//! Manager's Copy image to these. The dev smoke check is a devtools console
//! call in `tauri dev`:
//! `await window.__TAURI_INTERNALS__.invoke("clipboard_get_image")` answers an
//! `ArrayBuffer` holding the frame, and the same invoke with a frame as its
//! `Uint8Array` second argument sets one. Note the Linux dev build is not the
//! target: there the clipboard's content lives in the process that put it
//! there, so it lasts only as long as arboard's `Clipboard` handle (Windows
//! opens the OS clipboard per operation).
//!
//! Both commands open their own `Clipboard`: arboard holds the OS clipboard
//! only for the length of an operation, so nothing needs to stay alive
//! between calls.

use crate::clipboard;

/// Write an RGBA image to the system clipboard (SPEC §2). Request: raw body =
/// the binary frame (u32 LE width, u32 LE height, then its RGBA8 bytes).
/// Windows gets the registered PNG format plus an alpha-carrying `CF_DIBV5`;
/// the pixels are borrowed from the request body, not copied.
#[tauri::command(async)]
pub fn clipboard_set_image(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let frame = match request.body() {
        tauri::ipc::InvokeBody::Raw(frame) => frame,
        _ => return Err("clipboard set request must carry raw bytes".to_string()),
    };
    let (width, height, pixels) = clipboard::split_frame(frame)?;
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| format!("cannot open the system clipboard: {e}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: pixels.into(),
        })
        .map_err(|e| format!("cannot write the image to the system clipboard: {e}"))
}

/// Read the clipboard's image (SPEC §2). Response: the binary frame every
/// pixel command answers with, so the webview decodes it with `decodeFrame`.
/// A clipboard holding no image (text, files, nothing) is an error naming
/// that, not an empty image.
#[tauri::command(async)]
pub fn clipboard_get_image() -> Result<tauri::ipc::Response, String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| format!("cannot open the system clipboard: {e}"))?;
    let image = clipboard.get_image().map_err(|e| match e {
        arboard::Error::ContentNotAvailable => {
            "the clipboard holds no image (it is empty, or holds text or files)".to_string()
        }
        other => format!("cannot read the image from the system clipboard: {other}"),
    })?;
    Ok(tauri::ipc::Response::new(clipboard::to_rgba(&image)?.to_frame()))
}

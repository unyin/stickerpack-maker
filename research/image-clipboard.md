# Image clipboard: writing and reading PNG pixels with transparency

Research for the deferred SPEC item "Editor: real clipboard for Cut/Copy" (SPEC.md, deferred
list: Ctrl+C copies the selected pixels or layer to the system clipboard as PNG, Ctrl+X does
the same and leaves a transparent hole). Question: can the app put a PNG with alpha on the
Windows clipboard and read one back, so pixels move between this app, other apps and later
sessions, and which mechanism is the most robust?

Researched 2026-11-27 against source code and first-party docs. Versions: Tauri 2.12.7,
wry 0.57.3, tauri-utils 2.10.4 (this repo's lockfile, read from `~/.cargo/registry`),
tauri-plugin-clipboard-manager 2.5.0 (`plugins-workspace` branch `v2`), arboard 3.7.0
(`1Password/arboard` master), clipboard-win 5.4.3, Chromium `main`, Qt `qtbase` dev,
GTK 3.24.

## Short answer

Yes. Do the clipboard in Rust with **arboard** (directly, or through
tauri-plugin-clipboard-manager's Rust API, which is arboard underneath). On Windows arboard
writes a registered `"PNG"` format first and a straight-alpha 32-bit `CF_DIBV5` second, the
same two formats, in the same order, that Chromium writes. It reads `"PNG"` first, then
`CF_DIBV5`. The Editor already has the pixels in Rust, so Ctrl+C/Ctrl+X become a Rust command
that never sends pixels over IPC. Keep the existing webview `paste` event for Ctrl+V: it
already reads PNG first and also accepts files copied in Explorer. Optionally add a Rust read
command so the Paste button works too.

## How Windows carries a transparent image

- Windows has no standard clipboard format that means "PNG". Apps share one by calling
  `RegisterClipboardFormat` with the same name. "If more than one application registers a
  clipboard format with exactly the same name, the clipboard format is registered only once"
  ([MS: Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats)).
  The name in use is `"PNG"`. GTK says MS Office started it: "MS Office 2007, at least, offers
  images in common file formats using clipboard format names like "PNG" and "JFIF"" (GTK
  `gdk/win32/gdkselection-win32.c`, gtk-3-24).
- Standard bitmap formats: `CF_BITMAP` (HBITMAP), `CF_DIB` (BITMAPINFO + bits), and
  `CF_DIBV5` (BITMAPV5HEADER, which has an alpha mask)
  ([MS: Standard Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats)).
  The system synthesizes each of CF_BITMAP, CF_DIB and CF_DIBV5 from the others on request
  (MS: Clipboard Formats, "Synthesized Clipboard Formats" table). Synthesized or plain
  CF_DIB/CF_BITMAP have no defined alpha, so a reader that takes them gets an opaque image,
  or has to guess. Chromium's reader comments: "Windows doesn't really handle alpha channels
  well in many situations", and its 32-bpp DIB reading uses a heuristic that "will fail on a
  transparent bitmap containing only black pixels" (`ui/base/clipboard/clipboard_win.cc`).
- Order matters. "Clipboard formats that contain the most information should be placed on the
  clipboard first … A window pasting information from the clipboard typically retrieves a
  clipboard object in the first format it recognizes" (MS: Clipboard Formats, "Multiple
  Clipboard Formats").
- Data placed with `SetClipboardData` (not delayed rendering) belongs to the system after the
  clipboard closes, so it survives the app exiting. This is what lets a copied sticker be
  pasted in a later session.

The robust write is therefore **`"PNG"` first, then a correct `CF_DIBV5`**. Readers that know
PNG get lossless RGBA. DIBV5-aware readers get alpha. Everything else gets the synthesized
opaque CF_DIB/CF_BITMAP.

## What common readers take

| Reader | What it reads, in order | Source |
|---|---|---|
| Chromium / Edge / WebView2 (incl. this app's webview) | `"PNG"`; else `CF_DIB` through an alpha heuristic | `clipboard_win.cc` `ReadPngInternal`: "Read PNG if possible, otherwise fall back to reading as a bitmap" |
| Qt apps (Telegram Desktop is Qt) | an *original* (not synthesized) `CF_DIBV5`; else `"PNG"`; else CF_DIB | `qwindowsmimeregistry.cpp` `QWindowsMimeImage::convertToMime`: "Try to convert from DIBV5 as it is the most widespread format that supports transparency, but avoid synthesizing it" |
| GTK 3 apps (GIMP 3 on Windows) | maps `image/png` to the registered `"PNG"` format; also handles CF_DIBV5 | `gdkselection-win32.c` |
| MS Office | `"PNG"`; Chromium notes "Word support for DIBV5 is buggy and PNG format is needed for it" | `clipboard_win.cc` `WriteBitmap` comment |
| Paint (Windows) | not verified from a primary source. Classic Paint has no transparency, so any paste is flattened. Windows 11 Paint gained layers and transparency in 2024; whether it reads `"PNG"` from the clipboard is untested | needs a hands-on check |
| Photoshop | closed source, not verified. It needs a hands-on check: copy from this app with both formats present and paste | needs a hands-on check |

For Telegram Desktop the CF_DIBV5 is what counts, because Qt prefers it over PNG when it is an
original format. Qt writes and reads DIBV5 as straight (non-premultiplied) `Format_ARGB32`
with `bV5AlphaMask = 0xff000000` (`qt_write_dibv5` in the same file). arboard writes the same
straight layout (see (c)), so the two agree. Chromium's own DIBV5 is copied from a
premultiplied Skia bitmap (`skia/ext/skia_utils_win.cc`
`CreateDIBV5ImageDataFromN32SkBitmap`), so the two conventions differ in the wild. This
research did not verify which one a given reader assumes. Test semi-transparent edges once in
Telegram.

## (a) The webview's async Clipboard API (WebView2 under Tauri 2)

**Write: `navigator.clipboard.write([new ClipboardItem({"image/png": blob})])`**

- It works in principle. Blink's `ClipboardImageWriter` decodes the PNG ("`decoder` is nullptr
  if `png_data` doesn't begin with the PNG signature") with `ImageDecoder::kAlphaPremultiplied`
  and calls `system_clipboard()->WriteImage(bitmap)`
  (`third_party/blink/renderer/modules/clipboard/clipboard_writer.cc`). On Windows that is
  `ClipboardWin::WriteBitmap`: it re-encodes a PNG to `"PNG"` first, then writes `CF_DIBV5`
  (`clipboard_win.cc`; `BitmapType()` is `CF_DIBV5` and `PngType()` is
  `RegisterClipboardFormatChecked(L"PNG")`, per `clipboard_format_type_win.cc`). The formats
  on the clipboard are as good as arboard's.
- Fidelity cost: the image is decoded to **premultiplied** 8-bit and re-encoded, so the colour
  of low-alpha pixels (anti-aliased sticker edges, glow falloff) is rounded. The PNG on the
  clipboard is not byte-for-byte the app's PNG.
- Preconditions (`clipboard_promise.cc` `ValidatePreconditions`): a secure context (the IDL is
  `[SecureContext]`; the app's `http://tauri.localhost` origin counts, since `*.localhost` is
  potentially trustworthy, and `navigator.clipboard.writeText` already works in the Pack
  Manager), the **document must be focused**, and the permissions policy must allow it. A
  write is granted outright inside a `copy`/`cut` event (`IsExecutingCutOrCopy`). Otherwise
  the permission request carries `has_user_gesture`, so call it from the Ctrl+C keydown or a
  click.
- Cost: the pixels have to cross IPC Rust → JS as a PNG (as the save path does today), then go
  back into Chromium.

**Read: `navigator.clipboard.read()`**

- Blink's `ClipboardPngReader` returns what `SystemClipboard::ReadPng` gives, unchanged ("the
  data returned from ReadPng() is already in the desired format", `clipboard_reader.cc`). On
  Windows that is `"PNG"` if present, else CF_DIB turned into PNG.
- Permission: read needs `clipboard-read`. WebView2 defines
  `COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ` as "permission to read the system clipboard
  without a user gesture", and the default state "normally prompt[s] users for decision"
  ([WebView2 Win32 IDL reference](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl)).
  wry auto-allows it only when the webview was built with `clipboard: true`: it registers a
  `PermissionRequested` handler that sets `COREWEBVIEW2_PERMISSION_STATE_ALLOW` for
  CLIPBOARD_READ (wry 0.57.3 `src/webview2/mod.rs`, "Enable clipboard"). Tauri exposes this
  only as `WebviewWindowBuilder::enable_clipboard_access()` (tauri 2.12.7
  `src/webview/webview_window.rs`). `tauri.conf.json` window config has no such key
  (tauri-utils 2.10.4 `config.rs` has no clipboard field). The app's `main` window comes from
  `tauri.conf.json` and its webview is not built with clipboard access. That explains the
  Paste button's existing fallback message ("The clipboard can't be read here: press Ctrl+V to
  paste an image.", `src/views/editor.ts` `pasteFromButton`).
- Inside a `paste` event the read is implicitly granted (`IsExecutingPaste`). That is why
  today's Ctrl+V handler (`document.addEventListener("paste", …)` reading
  `clipboardData.items`) works without a prompt.
- Copied files (Explorer `CF_HDROP`) are not image data. The async API does not see them, but
  the paste event's `clipboardData` does (SPEC already notes this).

**Verdict (a):** the write is usable but lossy at low alpha, and it needs focus and a gesture.
The read needs the main window to move to a Rust-built `WebviewWindowBuilder` with
`enable_clipboard_access()`. Doable, but it moves window creation out of config for one
button.

## (b) tauri-plugin-clipboard-manager v2

- Backend: `arboard = { version = "3.6", features = ["wayland-data-control"] }` with default
  features on, so arboard's `image-data` is enabled (plugin `Cargo.toml`, version 2.5.0).
- Rust API: `write_image(&self, image: &tauri::image::Image)` passes `image.rgba()`, width and
  height to `arboard::Clipboard::set_image`. `read_image()` returns
  `Image::new_owned(rgba, w, h)` from `get_image()` (plugin `src/desktop.rs`). On Windows its
  formats are therefore exactly arboard's (see (c)). The interface is raw RGBA, not PNG.
- JS API: `writeImage(image: string | Image | Uint8Array | ArrayBuffer | number[])`.
  `readImage(): Promise<Image>`, a resource handle; pixels come back via `image.rgba()`
  (`guest-js/index.ts`). Byte inputs become tauri's `JsImage::Bytes`, decoded by
  `Image::from_bytes`, which exists only with the `tauri` cargo feature `image-png` (or
  `image-ico`). Without it: "expected RGBA image data, found raw bytes" (tauri
  `src/image/mod.rs`).
- Permissions: Tauri capabilities (`clipboard-manager:allow-write-image`,
  `clipboard-manager:allow-read-image`) in `src-tauri/capabilities/default.json`. There is no
  WebView2 prompt and no gesture or focus rule, since the work is native.
- Threading: `read_image`'s doc warns against calling it on the main thread (Linux deadlock).
  An async Tauri command avoids that.
- Cost: from JS the pixels cross IPC as RGBA or PNG twice (Rust → JS → Rust). From the Rust
  side the plugin is just a wrapper around arboard with a managed `Mutex<Clipboard>`.

**Verdict (b):** correct formats, lossless. It only pays off if JS needs a clipboard API. For
this app (pixels in Rust) the plugin's Rust handle works, but adds a plugin where a single
crate would do.

## (c) Rust crates: arboard and clipboard-win

**arboard 3.7.0** (`src/platform/windows.rs`; `image-data` is a default feature; Windows deps
`clipboard-win 5.3.1` and `image 0.25` with `png` and `bmp`):

- `set_image` empties the clipboard, then `add_png_file` (encodes `Rgba8`, registers
  `"PNG"`), then `add_cf_dibv5`. Comment: "The ordering of these functions is important, as
  some programs will grab the first format available. PNGs tend to have better compatibility
  on Windows, so it is set first."
- The DIBV5 is 32-bit `BI_BITFIELDS`, masks R `0x00ff0000`, G `0x0000ff00`, B `0x000000ff`,
  A `0xff000000`, `bV5CSType` sRGB, rows bottom-up ("MS Word (and WordPad) cannot paste an
  image that has a negative height in its header"). Pixels are converted straight to ARGB,
  with no premultiplication. CF_DIB is not written; Windows synthesizes it.
- `get_image`: `"PNG"` if present, else `CF_DIBV5` (CF_DIB data is synthesized into it by the
  system), decoded with `into_rgba8()`. It fixes Chromium/Electron headers that say `BI_RGB`
  with 32 bpp but carry alpha ("Chrome, and Chromium & Electron-based programs send us BI_RGB
  headers, but with bitCount=32 - and important transparency bytes in the alpha channel").
- No file-list (CF_HDROP) image read through `get_image`. Copied files stay with the webview
  paste event.
- `image 0.25` is already in this crate's tree, so adding arboard pulls little new: the `bmp`
  feature and clipboard-win.

**clipboard-win 5.4.3**: low-level Win32 wrapper. `formats::Bitmap` is `CF_BITMAP`;
`formats::RawData(format)` and a root `register_format` let you put arbitrary bytes under
`"PNG"` and hand-build a DIBV5 (docs.rs). That is exactly what arboard already does on top
of it. Use it directly only to put the app's **own already-encoded PNG** bytes on the
clipboard verbatim, or to add extra formats (e.g. `CF_HDROP` of a temp file, or
`ExcludeClipboardContentFromMonitorProcessing`). That means hand-written BITMAPV5HEADER code, which is
not worth it for v1.

**Verdict (c):** arboard gives the robust format set with straight alpha that matches Qt. It
reads back losslessly from its own PNG, and it needs no permissions, gestures or focus.

## Comparison

| | Write formats on Windows | Read | Alpha fidelity | Prompts / rules | Work to wire in |
|---|---|---|---|---|---|
| (a) async Clipboard API | `"PNG"` (re-encoded) + premultiplied `CF_DIBV5` | `"PNG"`, else CF_DIB heuristic | low-alpha colour rounded on write | focus + gesture to write; read prompts unless the window is built with `enable_clipboard_access()` | small JS for write; read needs the window moved to Rust setup |
| (b) clipboard-manager plugin | arboard's: `"PNG"` + straight `CF_DIBV5` | arboard's | lossless | capability entries only | add plugin + capabilities; RGBA over IPC if used from JS |
| (c) arboard in a Rust command | `"PNG"` + straight `CF_DIBV5` | `"PNG"`, else `CF_DIBV5` | lossless | none | one dependency + 1-2 commands; pixels never leave Rust |

## Recommended approach

1. Add `arboard = { version = "3", default-features = false, features = ["image-data"] }`
   (Windows-only target section, like `drag`, if Linux dev builds should not pull X11/Wayland
   clipboard code, with a stub elsewhere).
2. A Rust command `editor_copy_to_clipboard(doc, selection/region)` composites the selected
   pixels (or the selected layer) with the existing tiny-skia/merge path, unpremultiplies to
   straight RGBA8, and calls `Clipboard::new()?.set_image(ImageData { width, height, bytes })`
   on an async command thread. Ctrl+X calls it and then runs the existing Cut-to-hole edit as
   one undo step. JS only invokes the command. No pixels cross IPC.
3. Reading: keep the current Ctrl+V `paste` event. It reads `"PNG"` first through Chromium,
   needs no permission, and covers copied files. For the Paste button, add
   `editor_paste_from_clipboard` that calls `get_image()` and feeds the RGBA into the existing
   import/cap pipeline (`editor::import`, the same path `editor_import_pasted` uses). This
   removes the "can't be read here" fallback without touching window creation.
4. Before shipping, check by hand on Windows: paste into Telegram Desktop (DIBV5 path,
   semi-transparent edges), a browser (PNG path), GIMP, Windows 11 Paint, and Photoshop if
   available. Then confirm copy → quit → relaunch → paste works.

The plugin (b) is an acceptable stand-in for step 1 if a JS clipboard API is wanted elsewhere
later. Its Rust `app.clipboard().write_image(&Image::new(rgba, w, h))` is the same arboard
call. The webview API (a) is the weakest: lossy premultiplied re-encode, focus and gesture
rules, and a read permission the current window setup does not grant.

## Sources

- Microsoft Learn, [Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats) (registered, multiple and synthesized formats)
- Microsoft Learn, [Standard Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats)
- Microsoft Learn, [WebView2 Win32 IDL reference](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl) (`COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ`, `COREWEBVIEW2_PERMISSION_STATE_DEFAULT`)
- Chromium `main`: [`ui/base/clipboard/clipboard_win.cc`](https://chromium.googlesource.com/chromium/src/+/main/ui/base/clipboard/clipboard_win.cc), [`clipboard_format_type_win.cc`](https://chromium.googlesource.com/chromium/src/+/main/ui/base/clipboard/clipboard_format_type_win.cc), [`clipboard_util.cc`](https://chromium.googlesource.com/chromium/src/+/main/ui/base/clipboard/clipboard_util.cc), [`skia/ext/skia_utils_win.cc`](https://chromium.googlesource.com/chromium/src/+/main/skia/ext/skia_utils_win.cc), Blink [`clipboard_writer.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/clipboard/clipboard_writer.cc), [`clipboard_reader.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/clipboard/clipboard_reader.cc), [`clipboard_promise.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/clipboard/clipboard_promise.cc)
- wry 0.57.3 `src/webview2/mod.rs`, `src/lib.rs`; tauri 2.12.7 `src/webview/mod.rs`, `src/webview/webview_window.rs`, `src/image/mod.rs`; tauri-utils 2.10.4 `src/config.rs` (local cargo registry, this repo's lockfile versions; image module also at [tauri `dev`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/image/mod.rs))
- tauri-plugin-clipboard-manager 2.5.0: [`Cargo.toml`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/clipboard-manager/Cargo.toml), [`src/desktop.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/clipboard-manager/src/desktop.rs), [`guest-js/index.ts`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/clipboard-manager/guest-js/index.ts)
- arboard 3.7.0: [`Cargo.toml`](https://github.com/1Password/arboard/blob/master/Cargo.toml), [`src/platform/windows.rs`](https://github.com/1Password/arboard/blob/master/src/platform/windows.rs)
- clipboard-win 5.4.3: [docs.rs](https://docs.rs/clipboard-win/latest/clipboard_win/)
- Qt `qtbase` dev: [`src/plugins/platforms/windows/qwindowsmimeregistry.cpp`](https://github.com/qt/qtbase/blob/dev/src/plugins/platforms/windows/qwindowsmimeregistry.cpp)
- GTK 3.24: [`gdk/win32/gdkselection-win32.c`](https://gitlab.gnome.org/GNOME/gtk/-/blob/gtk-3-24/gdk/win32/gdkselection-win32.c)

Not verified from primary sources: what Paint and Photoshop read (closed source), and Telegram
Desktop's paste code beyond the Qt layer it builds on. These need the hands-on check in step 4.

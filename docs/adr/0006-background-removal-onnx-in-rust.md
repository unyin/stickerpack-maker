# Background removal: ISNet on ONNX Runtime in Rust, model downloaded once

Status: **Accepted** — owner approval 2026-11-23, after the Windows test of the feature
(including the packaging check: the app starts with no onnxruntime.dll, verified on the dev
run, the release build and the installer) and the single-model spot-check. The owner's
decisions of 2026-11-22 (CMT-242) are built in: rembg's release as the download host until
the file is mirrored to the project's own release (done in SPM-19, see the amendment
below), static ONNX Runtime, ISNet general use
as the model. The owner decision of 2026-11-23 dropped the second model (ISNet anime)
after the owner's Windows test judged it unusable: background removal is back to the single
general model, with no model choice in the UI (colour anime is out of scope; manga will
be handled by a separate magic-wand tool).

Background removal (SPEC §6) is one click on an image layer, offline after a one-time model
download (ADR-0001, SPEC §2), followed by a refine brush that erases or restores alpha by hand.
ADR-0005 put one-shot pixel work in Rust and named `ort` as the natural home for the model,
leaving this ADR to confirm where it runs and which model it is.

## Decision

**The model runs in Rust on ONNX Runtime (`ort`), statically linked. One model is used:
ISNet `isnet-general-use`, Apache-2.0. It is downloaded once on its first use from a pinned
URL, checked against a pinned SHA-256, and cached under the app data folder. The refine brush
runs in the webview.**

- **Runtime placement: Rust, `ort` 2.0 (ONNX Runtime 1.31).**
  - The webview sends the layer's RGBA bytes over binary IPC (as every pixel command does,
    ADR-0005) and gets the same layer back with its new alpha. One round trip per click.
  - ONNX Runtime uses every CPU core natively. In the webview, onnxruntime-web runs WASM
    (single-threaded unless the page is cross-origin isolated, which Tauri does not set up by
    default) or WebGPU (not yet available in every WebView2/WebKitGTK build), so the same model
    would be several times slower and behave differently per webview: the risk ADR-0001 flags.
  - The model file is read from disk by Rust; the webview never holds 179 MB of weights.
    The model's session is loaded once per run, and the process shares one ONNX Runtime
    environment, as ONNX Runtime requires.
- **Linking: `download-binaries`, static.** At build time `ort` fetches pyke's prebuilt ONNX
  Runtime for the target and links it into the executable (on Linux a `libonnxruntime.a`, on
  Windows an `onnxruntime.lib`): no `onnxruntime.dll` to ship, find or version-match. The cost
  is a bigger executable (roughly 15–25 MB more, to be measured on the Windows build) and a
  build-time download from pyke's CDN (cached in the user's cache folder after the first build).
  `ort` is pinned to an exact release candidate (`=2.0.0-rc.15`) because 2.0 is not final.
- **Model** (owner decision, 2026-11-23: the single model; the anime model offered on
  2026-11-22 was dropped after the owner's Windows test judged it unusable).
  - **ISNet `isnet-general-use`** (Qin et al., "Highly Accurate Dichotomous Image
    Segmentation", the DIS repository; Apache-2.0), the general-purpose model rembg offers.
  - It takes 1×3×1024×1024 RGB, scaled to 0–1 by the image's own maximum, then
    (x − 0.5) / 1 (rembg's `dis_general_use` session, checked 2026-11-22). The output is a
    1024×1024 map, min-max normalised to the mask, resized back to the layer with Lanczos3.
  - The mask **multiplies the layer's alpha**; colours are never changed, so the refine brush
    can bring pixels back exactly.
  - Every model fact (file name, URL, SHA-256, size, input side, mean, std) lives in one
    `ModelSpec` constant (`src-tauri/src/ml/model.rs`, `MODEL`), so another model of the same
    family is a one-constant change.
  - The model code lives in `src-tauri/src/ml/` (Tauri-free, unit-tested like
    `src-tauri/src/editor/`), a sibling of ADR-0005's editor pixel code because it also
    owns the download and cache.
- **Download: once, on the model's first use, verified, cached.**
  - The model's first **Remove background** asks first, in the shared two-option dialog
    (SPEC §2), naming its size. **Download** fetches it; **Cancel**, the safe
    default, does nothing.
  - The pinned source is rembg's release asset (until a later task mirrors it to the
    project's own release; only the URL changes):
    `https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx`,
    SHA-256 `60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a`,
    178,648,008 bytes.
  - Rust downloads over HTTPS (`ureq`, rustls with bundled roots: no OS TLS dependency),
    reports progress to the Editor's message line, and can be cancelled. It writes
    `<file>.part`, hashes while writing, and renames it into place only when the size and
    the SHA-256 match; anything else deletes the part file and says so.
  - Cache: `<app data>/models/isnet-general-use.onnx` (on Windows
    `%APPDATA%\com.stickerpackmaker.desktop\models\`). It is machine-local, like the
    config (not in the Library, which is portable and holds only packs).
  - The file is hashed again the first time it is loaded in each run of the app, so a
    damaged or replaced file is deleted and downloaded afresh rather than run.
- **Offline behaviour.** With the model cached, removal never touches the network.
  Without it and without a connection, the download fails with a plain message ("Could not reach the
  model download server (…). Check your internet connection and try again.") and nothing
  else changes; the next click tries again.
- **The refine brush stays in the webview** (ADR-0005): Erase and Restore paint alpha into the
  layer while the stroke happens; a finished stroke is one undo step. Restore paints back the
  layer's pixels from before its first background removal or Erase stroke, which the layer
  keeps with it until a pixel operation that changes its pixel grid (cut, Crop across it,
  merge, an effect) replaces it. Restore cannot reach past such a step (owner decision
  2026-11-22): on a press it says so and to undo that step first.

## Model comparison (2026-11-22, rembg's release assets)

| Model | Size | Licence | Fit |
|---|---|---|---|
| u2netp | 4.6 MB | Apache-2.0 | Tiny and fast, but coarse edges at 320×320 input; a fallback, not the default. |
| u2net | 176 MB | Apache-2.0 | Older, same size as ISNet, softer and blobbier masks at 320×320. |
| silueta | 44 MB | (rembg-trained u2net; unclear provenance) | Licence not stated clearly enough to ship. |
| **isnet-general-use** | **179 MB** | **Apache-2.0** | **The model. Sharp edges at 1024×1024 on general subjects (people, pets, objects, drawings).** |
| isnet-anime | 176 MB | Apache-2.0 (SkyTNT) | Tried as a second model (owner, 2026-11-22), dropped 2026-11-23: unusable in the owner's Windows test. |
| BiRefNet general-lite (swin tiny) | 224 MB | MIT | Best edges of the open models, but larger and several times slower on CPU. |
| BiRefNet general | 973 MB | MIT | Too large for a one-time download in a small app. |
| RMBG-1.4 / RMBG-2.0 (BRIA) | 44 MB / 1 GB | **Non-commercial** (BRIA licence / CC BY-NC 4.0) | Excluded: the licence forbids commercial use. |

ISNet's weights are Apache-2.0; they were trained on the DIS5K dataset, whose own terms are
for research. rembg and most tools that ship ISNet treat the weights as Apache-2.0; the owner
accepted the model on that basis (2026-11-22).

## Rejected alternatives

- **onnxruntime-web in the webview.** No native library, but slower (WASM threads need
  cross-origin isolation; WebGPU is not everywhere), different per webview, and the weights
  would live in the webview's memory. ADR-0005 already moved one-shot pixel work out of the
  webview.
- **`ort` with `load-dynamic`** (ship `onnxruntime.dll` beside the executable). A smaller
  executable, but the installer must bundle and locate the DLL, a second ONNX Runtime on the
  PATH can be picked up instead, and the total download is the same.
- **`tract` (pure-Rust ONNX inference).** No native code at all, but several times slower than
  ONNX Runtime on convolutional models of this size, and op coverage must be checked per model.
  The fallback if ONNX Runtime's Windows packaging fails.
- **Bundling the model in the installer.** Offline from the first click, but it would make a
  ~10 MB installer ~190 MB for a feature not everyone uses (ADR-0001's small-app goal).
- **rembg (Python).** Rejected in ADR-0001.

## Consequences

- **The app's only network requests in v1 are the model download,** only after the
  user agrees. SPEC §1's "no Telegram network calls" still holds.
- **Build machines need network on the first build** (pyke's CDN for ONNX Runtime); after that
  the archive is cached. The Windows build is where the static linking and the executable size
  are checked (owner test step, like libwebp in SPM-10).
- **Installed size grows by the static ONNX Runtime** (measured on Windows); the model
  (179 MB) is downloaded only by users who use it, into the app data folder, where
  uninstalling may leave it (a "remove downloaded models" setting is a possible follow-up).
  Running the model holds about its size in memory.
- **The download host is a third party** (rembg's GitHub release) until a later task mirrors
  the file to the project's own release: the pinned SHA-256 makes a changed file fail
  safely, but a removed one breaks the first download.
- **Third-party notices:** ISNet (Apache-2.0) and ONNX
  Runtime (MIT) need crediting wherever
  the app lists its licences.
- **A raster layer may carry a restore source** (its pixels before its first background
  removal or Erase stroke) in the document model. History counts it in the memory budget
  like any pixel buffer.

## Amendment (SPM-19, 2026-11-25)

The model is now served from the project's own `models` release on `unyin/stickerpack-maker`
(`https://github.com/unyin/stickerpack-maker/releases/download/models/isnet-general-use.onnx`),
a byte-identical mirror of rembg's release asset: the same SHA-256 and size, and only the URL
changed in `ModelSpec`. Verified 2026-11-26 by downloading through the public URL (HTTP 200
after one redirect, size and SHA-256 match) and by the app's own downloader
(`ml/download.rs`), which completed with its hash check. This supersedes the "download host
is a third party" consequence above.

- **Remaining risk:** the first download now depends on this project's `models` release and
  its tag. Deleting or renaming the tag or the asset breaks it; the pinned SHA-256 still makes
  a changed file fail safely.
- **Licence requirement:** hosting the ISNet weights ourselves is redistribution under
  Apache-2.0, so the release that hosts them must carry the licence notice and the credit for
  DIS (ISNet). This is a requirement of the mirror; whether the current release description
  has it yet is for the owner to check.

# Editor: hybrid split — Konva in the webview for interaction, Rust for pixel work

The Editor (SPEC §6) does two different kinds of work:

- **Interactive editing:** moving, scaling and rotating pasted cutouts and text; selection handles; z-order; pan/zoom; and the two live brushes, the refine brush (background removal) and the warp/bulge brush.
- **One-shot pixel work:** decoding the five import formats, the 2000×2000 scale-to-fit, destructive crop and the sizing tools, outline and fuzzy glow, merging layers, rasterising text, background removal, and the final flatten plus PNG/WEBP encode under the 512 KB cap.

Every operation needs undo/redo. The owner values the editing feel above all (ADR-0001), and wants as little home-grown tooling and webview dependence as practical (owner decision 2026-11-20).

## Decision

**Interaction runs in the webview on Konva (MIT, v10). One-shot pixel work runs in Rust on maintained crates. The document model and history are ours, so neither side owns the state.**

- **Document model and history (TypeScript, in the webview, no Konva types).**
  - A `Doc` has a size and an ordered list of layers. A **raster layer** is a pixel buffer plus a transform (position, scale, rotation). A **text layer** is text, a font, a size, a colour and a transform, and stays editable until it is merged or saved (SPEC §6).
  - Z-order and the "unsaved changes" flag live in the model too. Selection lives beside it in the session, and is **not an undo step**: clicking between layers never fills the history, and undo/redo drops selected layers that no longer exist.
  - **History records whole document states with structural sharing.** Layers are immutable values, so a step only allocates what changed. A transform or z-order change makes a new layer list that reuses every pixel buffer; a pixel operation produces one new buffer for one layer. Undo restores the previous state, and "unsaved changes" means the current state is not the one last saved.
  - The history is capped by a **memory budget**, not a step count. The budget counts each pixel buffer only the current state does not use, once each. The oldest steps drop first, so a long session at 2000×2000 cannot exhaust memory.
- **Konva is the view, plus the live brushes.**
  - One stage renders the model: a `Konva.Image` per raster layer (drawn from that layer's canvas), a `Konva.Text` per text layer, and a `Konva.Transformer` for the handles. Drag, wheel zoom and pan come from the stage.
  - Konva events become model commands. Konva never holds state the model lacks, so undo/redo and save never read from it.
  - Text is edited in a temporary `<textarea>` laid over the text node (Konva's documented pattern).
  - The refine and warp brushes paint into the layer's canvas in the webview while the stroke happens, because round-tripping every stroke to Rust would add visible lag. A finished stroke is one command.
- **Rust does the one-shot pixel work** behind typed Tauri commands. Pixels cross the boundary as raw RGBA bytes over Tauri's binary IPC, not JSON. The crates:
  - **`image`:** decodes .jpg/.jpeg/.jfif/.png/.webp, and encodes PNG.
  - **`fast_image_resize`:** the 2000-cap scale-to-fit and the sizing tools.
  - **`imageproc`:** morphology, distance transform and Gaussian blur, the building blocks of outline and fuzzy glow (SPM-8).
  - **`webp` (libwebp):** lossy WEBP encoding with a quality search to land at or under 512 KB / 128 KB (SPM-10).
  - **`ab_glyph` / `tiny-skia`:** rasterise text layers when they are merged or saved, so the output does not depend on the webview's text renderer.
  - **`ort`:** the natural home for background removal (SPM-7). Its own ADR-0006 confirms where it runs and which model.
- **The Rust pixel code lives in `src-tauri/src/editor/`** and is Tauri-free, like the Library core. It is unit-tested with `cargo test` on synthetic images. The TypeScript model and history are unit-tested with `bun test`.

## Rejected alternatives

- **Webview only (Konva plus our own TypeScript pixel functions).** No IPC cost, but outline, glow, resizing and the encoders become our code. WEBP encoding would depend on each webview's `toBlob`: WebView2 and WebKitGTK differ, which is exactly the risk ADR-0001 flags.
- **A ready-made editor.** TOAST UI Image Editor has been frozen at 3.15.x since 2022 on an old Fabric. Filerobot v5 is a long-running React beta. Pintura is paid. Photopea is online and closed. None has mergeable layers, an alpha refine brush or warp, and each would have to be forked to meet SPEC §6's hard rules (fixed 512 box, hard-blocked save, merge selected layers).
- **Fabric.js as the canvas library.** It has inline text editing built in, but its objects *are* the state, and its undo serialises the whole canvas (raster data URLs included). That is heavy at 2000×2000, and it is ~10× Konva's size.
- **A native GUI for the editor (egui, Slint, Iced).** It would remove the webview entirely, but contradicts ADR-0001's Tauri decision and splits the app into two UI stacks.

## Consequences

- **Dependencies:** one runtime JS dependency (`konva`), and a handful of Rust crates. `webp` and `ort` bundle native libraries (libwebp, ONNX Runtime), so the Windows build is the place to check their packaging.
- **Each one-shot operation pays an IPC round trip.** A 2000×2000 RGBA buffer is 16 MB, so that is tens of milliseconds: invisible for one-click actions. Live interaction never pays it.
- **Saved output is produced by Rust,** so files are identical regardless of the webview. The save pipeline (SPM-10) validates size and dimensions on the bytes it actually writes, and the core writes them into packs (SPM-2's `add_stickers` / `replace_sticker_file`).
- **Background removal (SPM-7) plugs in as a pixel operation.** The model runs offline as ONNX: a U²-Net/ISNet-class model, the same families rembg uses, but without rembg's Python dependency (rejected in ADR-0001). It produces an alpha mask that a command applies to a raster layer; the refine brush then edits that alpha live. ADR-0006 decides the model and confirms `ort`.
- **Text layers stay vector data** until a merge or the save rasterises them in Rust. After that they are pixels (no project files, SPEC §6).
- **The history's memory budget is a tunable constant.** The owner feels it only as "very old steps can't be undone" in very long sessions.
- **Swapping Konva later only means rewriting the view layer** (`src/editor/view/`), because the model and the Rust pixel code never depend on it.

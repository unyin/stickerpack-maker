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

## Amendment (SPM-9, 2026-11-20; owner confirmed 2026-11-21)

**Text layers are drawn on the canvas from their Rust rendering, not by `Konva.Text`.**

- When a text layer is created or its text, font, size or colour changes, Rust lays it out and
  rasterises it at scale 1 (`editor_render_text`; `ab_glyph` outlines filled by `tiny-skia`, system
  fonts found with `fontdb`). The model keeps that rendering beside the text, and the stage shows it
  as a `Konva.Image`, transformed like any layer.
- Why: the sizing tools measure the whole image, text included (CMT-61), and the save and merge
  rasterise text in Rust. Measuring with Konva's font metrics while Rust draws the pixels would let
  "longest side exactly 512" drift; a webview font and a Rust font can differ in metrics, hinting and
  kerning. With one rasteriser the view, the measurement, merge, Crop and the save all agree.
- Merge, Crop and the save rasterise text again from its outlines at the layer's transform, so a
  scaled-up text is sharp in the output; the canvas preview of a scaled-up text is the scale-1
  rendering enlarged, so it can look softer than the result.
- Editing still uses the `<textarea>` overlay, styled with the same family and the Rust line metrics;
  each committed edit costs one small IPC round trip.

## Amendment (SPM-20, 2026-11-24)

**The text-editing overlay is styled with the layer's family followed by the emoji style stack.**

- The overlay's `font-family` is the chosen family first, then `var(--font-emoji)`, the style stack the
  rest of the DOM draws emoji with (SPM-17). Chosen font first keeps covered glyphs, text-presentation
  included, in the layer's own font; the emoji style stack next makes `Emoji_Presentation` emoji preview
  in the same font the canvas commits, because the Rust chain routes those emoji through the same style
  stack per character (owner report 2026-11-24). This supersedes "styled with the same family" above.
- A glyph the chosen family lacks may fall to the style stack before the webview's system fallback, so
  the preview can show it in the emoji font while Rust keeps it with the text font. That is an accepted
  approximation of the fallback, not a mismatch the overlay can avoid.

## Amendment (SPM-23, 2026-11-24)

**The selection has its own undo trail beside the document history — it still never enters it.**

- Ctrl+Z/Ctrl+Y step the selection back and forward while selection steps exist (one step per committed selection change; a tolerance drag is one step), then fall through to document undo/redo exactly as before; the toolbar Undo/Redo buttons follow the same route. The core stands: the document's history records document states only, and "unsaved changes" never moves when a selection is edited.
- Why the trail is safe: the two histories never interleave, though both may hold steps at once (a plain region surviving an edit can carry fresh ones beside live document history) — Ctrl+Z drains the selection's steps before document undo ever runs, and a document edit clears the trail outright.
- The trail lives and dies with the selection: every step-back keeps the redo trail; Esc, a document edit, an undo/redo that drops the region, or a Cut/Delete that consumes it clears both (owner, 2026-11-24: "undo shouldn't clear the step history unless it completely removes the selection" — operationalized as: what kills the selection kills its trail).
- The stored selection also stays visible under every draft while it draws, and bare Alt is marked handled so the Windows system menu never engages (owner re-test rulings, same date; SPEC §6 carries the behavior).

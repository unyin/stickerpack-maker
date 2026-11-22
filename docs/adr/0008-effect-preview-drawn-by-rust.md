# Effect previews are drawn by Rust, with Apply's own code

Outline and fuzzy glow are one-shot pixel work in Rust (ADR-0005), applied once and baked into
the layer's pixels (owner decision 2026-11-22). The owner also wants a **live preview** while the
settings are adjusted, before **Apply** (SPEC §6). ADR-0005 says live interaction normally avoids
the IPC round trip, so the preview needed its own decision (SPM-8, CMT-183).

## Decision

**The preview is the result: Rust draws it with the same `editor::effects::apply` that Apply
uses, through the same command (`editor_apply_effect`). Apply commits the preview it shows; it
does not draw again.**

- **One render at a time, latest settings next.** While a slider is dragged, the settings change
  faster than Rust answers. `EffectPreview` (src/editor/view/effect-preview.ts) runs one render
  at a time; when it finishes, it draws only the newest settings, skipping the ones in between.
  No timer debounce: the round trip itself paces the updates, so a fast machine or a small layer
  updates as fast as it can.
- **Discarding is structural.** The preview is wanted for (document state, target layer,
  settings). A new document state (any edit, undo/redo) or another target drops the shown
  preview at once; new settings keep it until the next one arrives, so dragging never flickers.
  It is shown as a view-only override of the layer's node (`EditorStage.setOverride`), never in
  the model, so it cannot enter the history or make the document dirty (CMT-186).
- **Apply** takes the finished render for the current request, or waits for the one being
  drawn, and bakes it as one undo step. Preview and result cannot differ.
- **Speed.** Measured in `effects::tests::effect_timings` (a square layer with a transparent
  border; WSL2, one core):

  | Layer side | outline 10 px | outline 50 px | glow 30 px | glow 100 px |
  |---|---|---|---|---|
  | 512 (release) | 4 ms | 5 ms | 7 ms | 12 ms |
  | 1000 (release) | 14 ms | 17 ms | 24 ms | 35 ms |
  | 2000 (release) | 80 ms | 89 ms | 127 ms | 141 ms |
  | 2000 (`tauri dev`) | 276 ms | 341 ms | 347 ms | 445 ms |

  Plus the IPC transfer of the layer and the result (up to ~16 MB each way at the import cap).
  Sticker-sized layers update well within a frame budget; a 2000 px layer updates a few times a
  second, which the latest-wins scheduling keeps responsive. `tauri dev` builds `imageproc` and
  `image` optimised (`[profile.dev.package.*]`), which made the dev build ~4× faster.

## Rejected alternatives

- **A webview approximation (canvas `shadowBlur`, CSS `drop-shadow`) for the preview, Rust for
  Apply.** No IPC while dragging, but the preview would differ from the result (blur shape,
  outline corners, anti-aliasing) and from webview to webview (ADR-0001's WebView2/WebKitGTK
  risk). The owner tests the preview by eye; it must be what Apply gives.
- **Both in the webview.** Our own distance transform and blur in TypeScript: home-grown pixel
  code ADR-0005 rejected.
- **A reduced-resolution preview.** Faster at 2000 px, but again not the result; the measured
  speed did not need it.

## Consequences

- A preview costs a round trip per settings change actually drawn. If very large layers feel
  slow on the owner's machine, the next step is caching the layer's bytes on the Rust side
  between previews (only the settings would cross), not a different renderer.
- The glow's blur is three box blurs (imageproc `box_filter`), a close Gaussian approximation
  with an exactly finite reach, in place of the "Gaussian blur" ADR-0005 lists: a true Gaussian
  of the same reach costs a kernel per pixel and has an infinite tail the layer would clip.
- Effect parameter ranges are UI choices kept in src/editor/model/effects.ts; Rust only refuses
  invalid values and results larger than `MAX_LAYER_SIDE`.

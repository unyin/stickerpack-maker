# Triage: Editor tools and layers

Type: grilling
Status: resolved

## Question

Verdict (v2 / v3 / rejected) for each Editor item in the v2 lot: every selection-box edge grabbable for resizing; custom canvas resizing; Crop dropping a crossing layer whose inside part is fully transparent; text-to-image conversion button (Text category, per the SPEC entry's constraints); Shift-drag snap to whole pixels or a grid (Shift+click already toggles selection; no grid exists yet); layer locking; mirror a layer (vertical axis, horizontal if cheap); crop a layer to its content; Editor defaults configurable in Settings.


## Answer

Owner verdicts (2026-11-27, two rounds; round 1 at 12:13 in a session that then died, resumed and finished in the next). Costs are rough, in focused agent sessions.

**v2**

- **Edge handles on the selection box** (~0.5): all eight handles keep the aspect ratio. Each anchors on its opposite point: a corner on the opposite corner, an edge on the middle of the opposite edge (dragging the right edge grows the width and the height by the same ratio, split evenly above and below). The scale stays uniform, so text layers need nothing new in the Rust renderer. On a rotated layer the handles follow the layer's own edges.
- **Custom canvas resize** (~0.5-1): type width x height; the canvas changes size without scaling anything, centre anchor only (a 9-point anchor picker can come later if missed). Layers keep their place.
- **Crop drops a crossing layer whose inside part is fully transparent** (~0.25): an all-transparent check in the existing Rust crop, discarding the layer in the same undo step; text layers follow the same rule; the "at least one layer" guard still applies.
- **Text-to-image button** (~0.5): in the Text category (per the SPEC entry), reusing the existing Rust rasterising.
- **Whole-pixel landing** (~0.75), no modifier key (so no clash with Shift+click): moves round the position to whole pixels; resizes land the dragged side on a whole-pixel size, the other side rounding to its nearest whole pixel (the ratio may drift under a pixel); Rectangle selection corners snap to whole pixels so the outline shows exactly what Cut/Delete take; Lasso stays freehand (it already takes whole pixels by centre); rotated layers snap position only.
- **Layer locking** (~1): a lock toggle per layer-list row. A locked layer cannot be picked on the canvas, moved, painted or effected; it stays selectable from the layer list (to unlock or delete it); whole-image tools (sizing, Crop) still affect it. Finer edge cases are settled at implementation.
- **Mirror a layer** (~0.5): both axes (left-right and top-bottom), flipping the pixels in Rust as one undo step, no change to the transform model. Image layers only; on a text layer the button is disabled with "Convert to image first" (the text-to-image button makes that one click).
- **Crop a layer to its content** (~0.5): trims the transparent border, keeps the on-canvas position, one undo step, image layers only.
- **Editor defaults in Settings** (~1.5+): the full set of tool fields in Settings (brush and radius sizes, text font/size/colour, outline, glow, warp, wand tolerance, etc.), plus a "Reset Editor defaults" button that restores the built-in values. The Settings values are what each Editor session starts with; changes made inside the Editor still last only until the app closes and never write back to Settings.
- **Editor right-click menu** (~0.5, on top of the reusable menu decided in "Triage: Pack Manager interactions"): which commands and tools it holds is decided at implementation; every command must stay reachable without the menu.

**v3**

- **Grid with snapping** (the grid half of the Shift-drag snap entry): needs a grid overlay, its settings and a modifier that does not clash with Shift (~1-1.5).

**Rejected**: none.

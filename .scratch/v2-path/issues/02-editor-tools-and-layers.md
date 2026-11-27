# Triage: Editor tools and layers

Type: grilling
Status: claimed

## Question

Verdict (v2 / v3 / rejected) for each Editor item in the v2 lot: every selection-box edge grabbable for resizing; custom canvas resizing; Crop dropping a crossing layer whose inside part is fully transparent; text-to-image conversion button (Text category, per the SPEC entry's constraints); Shift-drag snap to whole pixels or a grid (Shift+click already toggles selection; no grid exists yet); layer locking; mirror a layer (vertical axis, horizontal if cheap); crop a layer to its content; Editor defaults configurable in Settings.

## Progress

Round 1 answered by the owner (2026-11-27, 12:13; the session then died on a billing error, resumed in a new session):

- Q1 edge handles: owner proposes edges that KEEP the aspect ratio, anchored on the middle of the opposite edge (follow-up open).
- Q2 custom canvas resize: v2, centre anchor only.
- Q3 Crop drops an all-transparent crossing layer: v2.
- Q4 text-to-image button: v2.
- Q5 (a) moves land on whole pixels: v2, owner asks whether resizes and selections also land on whole pixels, wants that in v2 if not (follow-up open); (b) grid with snapping: v3.
- Q6 layer locking: v2, with the proposed rules (locked = not pickable on canvas, not movable/paintable/effectable; still selectable from the layer list; whole-image tools still affect it).
- Q7 mirror: v2, both axes, image layers only (text: disabled, "Convert to image first").
- Q8 crop layer to content: v2, image layers only.
- Q9 Editor defaults: v2, option (a), the full set of tool fields in Settings, plus a "Reset Editor defaults" button.
- Q10 Editor right-click menu: v2; exact commands decided later; every command must stay reachable without the menu.

# Triage: Emoji fonts

Type: grilling
Status: claimed

## Question

Verdict (v2 / v3 / rejected) for the emoji font library (app-owned fonts/ folder; inverts SPM-17's store-the-path decision; CMT-340) and .ttc emoji font support (Rust unwraps the TTC container; CMT-342). Decide them together: .ttc sits naturally beside the library.

## Progress

Owner answers so far (2026-11-27):

- Emoji font library: v2.
- The custom font the owner wants: Apple Color Emoji (.ttc, sbix bitmaps).
- SPEC §6's "woff2 decoding and bitmap blitting are parked for v2" is triaged in this ticket too.
- woff2 fonts on the canvas: v3.
- SVG-in-OpenType fonts on the canvas: rejected (COLR builds of the same artwork cover it; not worth an SVG renderer).
- Research (WebView2/OTS, 2026-11-27): raw Apple Color Emoji cannot work as shipped: its ligatures (skin tones, flags, ZWJ, keycaps) live in AAT morx, which OTS drops and the Rust renderer does not apply; newer builds store EMJC glyphs nobody here decodes. OTS passes CBDT/CBLC and sbix; Windows renders them via Skia Fontations. Blink refuses web fonts over 128 MB (our guard allows 256 MiB).
- Size cap: the library's copy guard refuses fonts over WebView2's 128 MB limit with a clear message, part of the library task, v2 (owner).
- Open: .ttc verdict (Q6) and bitmap canvas painting (Q7, depends on Q6). The owner tried a converted build, Desktop/AppleColorEmoji-Windows.ttf (256,391,076 bytes, over the 128 MB limit), and it was rejected; an analysis agent is finding why and how to fix it.

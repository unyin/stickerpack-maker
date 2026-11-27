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
- Open: .ttc verdict and bitmap (sbix/CBDT) canvas painting, waiting on a research agent (does WebView2 render sbix web fonts; does Apple's font use AAT morx rather than GSUB for ZWJ/flags/skin tones). Known locally: ttf-parser 0.25 already parses TTC members and exposes sbix/CBDT glyphs as PNG; the image crate decodes PNG.

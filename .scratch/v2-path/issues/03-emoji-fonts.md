# Triage: Emoji fonts

Type: grilling
Status: resolved

## Question

Verdict (v2 / v3 / rejected) for the emoji font library (app-owned fonts/ folder; inverts SPM-17's store-the-path decision; CMT-340) and .ttc emoji font support (Rust unwraps the TTC container; CMT-342). Decide them together: .ttc sits naturally beside the library.


## Answer

Owner verdicts (2026-11-27). Scope widened at the owner's yes to include SPEC §6's "woff2 decoding and bitmap blitting are parked for v2" (custom emoji fonts the Rust canvas cannot paint fall back to Noto), which the §9 lot did not list. The owner's target font is Apple Color Emoji. Costs are rough, in focused agent sessions.

**v2**

- **Emoji font library** (~1): the app keeps its own `fonts/` folder in the app-config directory, copies a picked custom emoji font into it, and lists the copies as entries in the Settings Emoji font dropdown (add/remove; pick once, reuse forever; survives the original moving). Today's stored custom path is moved into the library once. This reverses SPM-17's "store the path, not a copy" decision (2026-11-21); the implementer records the reversal. Part of the same task: the copy guard refuses fonts over WebView2's 128 MB web-font limit with a clear message naming that limit (today the app's own cap is 256 MiB and the engine refuses with an opaque "Invalid font data").
- **Bitmap emoji painting on the canvas** (~1): the Rust text renderer paints CBDT/CBLC bitmap emoji (and PNG sbix through the same path; ttf-parser 0.25 exposes both as PNG, the image crate decodes them), scaled and composited in the existing tiny-skia path, so text layers draw the custom font instead of falling back to Noto. Known limit: the owner's font tops out at a 96 px strike, so emoji in large text are scaled up from 96 and look slightly soft (the DOM has the same limit).

**v3**

- **woff2 custom fonts on the canvas** (~0.5): does not serve the owner's font.
- **Auto-slim at import** (~1, 200-300 lines of byte-level Rust): for a CBDT font over 128 MB, keep the largest strike that fits and store that copy. The owner's one such font is already slimmed by hand (below), so v2's clear over-limit message suffices.

**Rejected**

- **.ttc emoji font support** (owner, 2026-11-27): the .ttc emoji font worth having is Apple's, whose ligatures (skin tones, flags, keycaps, ZWJ sequences) live only in AAT `morx`, which WebView2's sanitiser (OTS) drops and the canvas does not apply; converted .ttf builds with GSUB cover it.
- **SVG-in-OpenType emoji fonts on the canvas** (owner, 2026-11-27): COLR builds of the same artwork cover it; not worth an SVG renderer in the text path.

**Findings behind the verdicts** (two research agents, 2026-11-27; reproduced in headless Chromium 159 with the app's `new FontFace(name, arrayBuffer).load()` pattern):

- Blink refuses web fonts over 128 MiB (`kMaxDecompressedSizeMb`, web_font_decoder.cc: "Web font size more than 128MB"; JS only sees "Invalid font data in ArrayBuffer"). OTS passes CBDT/CBLC, sbix, COLR/CPAL and GSUB/GPOS/GDEF; it drops SVG, morx, kerx, trak. It requires glyf+loca, CFF/CFF2, or CBDT+CBLC, so sbix alone is rejected. On Windows, sbix/CBDT web fonts render through Skia Fontations.
- The owner's converted `AppleColorEmoji-Windows.ttf` (256,391,076 bytes; internal name "Segoe UI Emoji" 1.60) is a clean CBDT/CBLC font with 12 strikes (20-96 ppem; 96 is 62.5 MiB) and GSUB `ccmp` ligatures (3,989) beside Apple's morx. The 128 MB limit was the only cause of its rejection; OTS sanitises it with no warnings.
- Fix applied: a copy keeping only the 96 ppem strike, `AppleColorEmoji-Windows-96only.ttf` (66,360,392 bytes, on the owner's Desktop beside the untouched original), made with [keep_strike.py](../assets/keep_strike.py) (fontTools: `keep_strike.py in.ttf out.ttf 96`). It loads in Chromium and draws skin tones, flags, keycaps and ZWJ families as single colour glyphs; about 200 distinct morx-only images stay unreachable in the webview. Usable in Settings today for the DOM; the canvas needs the v2 bitmap painting.
- The raw `AppleColorEmoji.ttc` (189,791,856 bytes): 2 faces, sbix with 9 strikes up to 160 ppem, all PNG (no EMJC/flip/dupe in this build), no GSUB (ligatures in morx only); also over 128 MB.

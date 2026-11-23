# Bundled emoji fonts

Vendored font binaries and their licence texts, served by Vite (`public/` →
`dist/`, Tauri's frontendDist) and referenced by the `@font-face` rules in
`src/styles.css` with the internal family aliases `SPM Noto Color Emoji` and
`SPM Twemoji`. Never modify these binaries in place; replace with a fresh
upstream build and pin the new provenance below (SPM-17).

| File | Source (upstream) | sha256 | Licence |
|---|---|---|---|
| `Noto-COLRv1.ttf` | `googlefonts/noto-emoji`, `2D/fonts/Noto-COLRv1.ttf` (branch `main`, Unicode 16.0 era artwork) | `b8e25ea68db82f9e4d0aee921f4420be2be39887bd5c893a2ad98710531f9d0c` | SIL OFL 1.1 (`Noto-OFL.txt`) |
| `Twemoji_COLRv1.ttf` | `Nerixyz/twemoji-colr-font` release `v0.0.2` (2025-11-20), asset `Twemoji_GlyfColr1.ttf` — a COLRv1 build of the Twemoji artwork (`jdecked/twemoji`) | `ea1ca11000996b97b28cf81106d5e4b0295dc7dc5425d516d61b48fcdd22a6a0` (matches the release's published digest) | artwork CC-BY 4.0 (`Twemoji-LICENSE-GRAPHICS.txt`; credit line shown in Settings) |

Both files verified locally (opentype.js cmap read, 2026-11-24) to cover the
Unicode 15 emoji that the installed Segoe UI Emoji lacks, e.g. U+1FAF5 🫵
(CMT-176), plus 15.1 (U+1FAF8) and 16.0 (U+1FACE) arrivals.

The custom-font option ships nothing: it stores the user's chosen path in the
app config and loads it at runtime with `FontFace` (SPM-17).

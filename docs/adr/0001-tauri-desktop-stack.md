# Tauri desktop stack (Rust core + web UI)

The owner is a non-programmer who prioritizes a good canvas editing experience but wants a small installed app, on Windows now and macOS (possibly Linux) later. We chose Tauri — a Rust core with a web-frontend canvas editor — over Electron (one language and the biggest ecosystem, but ~200–300 MB installed) and Python/PySide (best ML ecosystem, but weaker canvas UX and fiddly cross-platform packaging). The two-language split and Rust image/ML plumbing are the accepted cost; difficult implementation choices get their own ADRs and detailed task breakdowns.

## Consequences

- Canvas editing lives in the webview (a JS canvas library); file, library, and SQLite operations live in Rust.
- Background removal must run offline via ONNX — either in Rust (e.g. `ort`) or in the webview (onnxruntime-web) — not via a Python `rembg` dependency. Which side runs it is a follow-up decision.
- macOS/Linux support later is mostly re-packaging, but native webview differences must be tested, not assumed.
